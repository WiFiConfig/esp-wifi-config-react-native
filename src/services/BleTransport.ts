/**
 * BleTransport — Layer 1 of the ESP WiFi Config library.
 *
 * Wraps `@orbital-systems/react-native-esp-idf-provisioning`, which itself
 * wraps Espressif's native iOS / Android provisioning SDKs. Provides:
 *
 *   - BLE scanning filtered by device-name prefix (`PROV_*` by default)
 *   - Connection / session-init using the configured Security 1 / 2 PoP
 *   - Reference holding for the active `ESPDevice` so DeviceProtocol /
 *     ProvisioningManager can hand off scan / provision / sendData calls
 *   - Typed event emission for the store / hooks / screens
 *
 * The native SDK does not stream individual discoveries — `searchESPDevices`
 * resolves with the full list at the end of a scan cycle. We emit
 * `deviceDiscovered` once per matched device when results land, then a
 * single `scanCompleted` — there is no live per-advertisement discovery
 * stream, that is just what the underlying SDK supports.
 */

import * as NativeProvisioning from '@orbital-systems/react-native-esp-idf-provisioning';
import {
  ESPDevice,
  ESPProvisionManager,
  ESPSecurity,
  ESPTransport,
} from '@orbital-systems/react-native-esp-idf-provisioning';

import type {
  BleConnectionState,
  ConnectedDeviceInfo,
  DeviceAuthCredentials,
  BleTransportEvents,
  BleTransportConfig,
  SecurityVersion,
} from '../types';

import { BleLibraryError } from '../types/ble';

import {
  DEVICE_NAME_PREFIX,
  DEFAULT_SCAN_TIMEOUT_MS,
  DEFAULT_SECURITY2_USERNAME,
} from '../constants/ble';

import { TypedEventEmitter, createLogger } from '../utils';
import { OperationCancelledError, OperationTimeoutError, waitForOperation } from '../utils/operations';

const log = createLogger('BleTransport');

interface ResolvedConfig {
  deviceNamePrefixes: string[];
  scanTimeoutMs: number;
  connectTimeoutMs: number;
  security: SecurityVersion;
  /**
   * No default. `undefined` = not configured (wizard prompts; headless
   * `connect()` throws `missing_credentials`). `''` = the device runs
   * Security 1 with no PoP and connects without prompting.
   */
  proofOfPossession: string | undefined;
  username: string;
  promptForAuth: boolean;
}

function normalizePrefixes(input?: string | string[]): string[] {
  if (input == null) return [DEVICE_NAME_PREFIX];
  return Array.isArray(input) ? input : [input];
}

function resolveConfig(config?: BleTransportConfig): ResolvedConfig {
  return {
    deviceNamePrefixes: normalizePrefixes(config?.deviceNamePrefix),
    scanTimeoutMs: config?.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
    connectTimeoutMs: config?.connectTimeoutMs ?? 20000,
    security: config?.security ?? 1,
    proofOfPossession: config?.proofOfPossession,
    username: config?.username ?? DEFAULT_SECURITY2_USERNAME,
    promptForAuth: config?.promptForAuth ?? false,
  };
}

function toEspSecurity(s: SecurityVersion): ESPSecurity {
  switch (s) {
    case 0:
      return ESPSecurity.unsecure;
    case 2:
      return ESPSecurity.secure2;
    case 1:
    default:
      return ESPSecurity.secure;
  }
}

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function mapBleError(error: unknown, fallback: 'scan_error' | 'connect_error'): BleLibraryError {
  const message = error instanceof Error ? error.message : String(error);
  const nativeCode = nativeErrorCode(error);
  const codes = {
    bluetooth_unauthorized: 'bluetooth_unauthorized',
    bluetooth_powered_off: 'powered_off',
    bluetooth_unavailable: 'unsupported',
    connect_timeout: 'connect_timeout',
    session_init_failed: 'session_init_failed',
    security_mismatch: 'security_mismatch',
    missing_pop: 'missing_credentials',
    missing_username: 'missing_credentials',
  } as const;
  if (nativeCode && nativeCode in codes) {
    return new BleLibraryError(codes[nativeCode as keyof typeof codes], message);
  }
  if (error instanceof OperationTimeoutError) return new BleLibraryError(fallback === 'connect_error' ? 'connect_timeout' : fallback, message);
  // Only older bridges need text fallback. A generic session-init failure is
  // not evidence of incorrect credentials; retain it as a connection error.
  if (/powered[\s_-]*off|\b(?:bluetooth|radio)\b.{0,40}\b(?:off|disabled)\b/i.test(message)) {
    return new BleLibraryError('powered_off', message);
  }
  if (/\bpermission\b.{0,60}\b(?:denied|missing|required)\b|\b(?:missing|denied|required)\b.{0,60}\bpermissions?\b/i.test(message)) {
    return new BleLibraryError('bluetooth_unauthorized', message);
  }
  if (/unauth/i.test(message)) return new BleLibraryError(fallback === 'scan_error' ? 'bluetooth_unauthorized' : 'unauthorized', message);
  if (/bad pop|invalid (?:pop|proof|password|credential)/i.test(message)) return new BleLibraryError('unauthorized', message);
  return new BleLibraryError(fallback, message);
}

export class BleTransport extends TypedEventEmitter<BleTransportEvents> {
  private readonly config: ResolvedConfig;

  private _connectionState: BleConnectionState = 'disconnected';
  private _device: ESPDevice | null = null;
  private _connectedDeviceInfo: ConnectedDeviceInfo | null = null;
  private scanController: AbortController | null = null;
  private connectController: AbortController | null = null;
  private pendingDevice: ESPDevice | null = null;
  private unsubscribeDisconnect: (() => void) | undefined;
  private _destroyed = false;

  // ────────────────────────────────────────────────────────────────────
  // Constructor
  // ────────────────────────────────────────────────────────────────────

  constructor(config?: BleTransportConfig) {
    super();
    this.config = resolveConfig(config);
    // Compatible with older SDK wrappers; the local native integration adds
    // this listener without making Android emit an unidentified global event.
    const native = NativeProvisioning as typeof NativeProvisioning & {
      addDeviceDisconnectListener?: (
        listener: (event: { deviceName: string; reason?: string }) => void,
      ) => () => void;
    };
    this.unsubscribeDisconnect = native.addDeviceDisconnectListener?.((event) => {
      if (this._device?.name !== event.deviceName && this.pendingDevice?.name !== event.deviceName) return;
      this.connectController?.abort();
      this.connectController = null;
      this.pendingDevice = null;
      this._device = null;
      this._connectedDeviceInfo = null;
      this.setConnectionState('disconnected');
    });
    log.info('BleTransport created', {
      prefixes: this.config.deviceNamePrefixes,
      security: this.config.security,
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Public getters
  // ────────────────────────────────────────────────────────────────────

  get isConnected(): boolean {
    return this._connectionState === 'connected';
  }

  get connectedDevice(): ConnectedDeviceInfo | null {
    return this._connectedDeviceInfo;
  }

  get connectionState(): BleConnectionState {
    return this._connectionState;
  }

  /**
   * The active `ESPDevice` reference, if connected.
   *
   * Exposed (unstable) so the protocol / manager layers can call
   * `provision()` / `scanWifiList()` / `sendData()` on it. Most
   * application code should not touch this directly.
   */
  get espDevice(): ESPDevice | null {
    return this._device;
  }

  /** Resolved configuration (after defaults applied). */
  get resolvedConfig(): Readonly<ResolvedConfig> {
    return this.config;
  }

  // ────────────────────────────────────────────────────────────────────
  // Scanning
  // ────────────────────────────────────────────────────────────────────

  /**
   * Start a BLE scan for devices matching any configured prefix. The
   * native SDK does not stream individual discoveries — once the scan
   * resolves, every matched device is emitted as a separate
   * `deviceDiscovered` event followed by a single `scanCompleted`.
   *
   * The scan settles within `scanTimeoutMs` even if native never calls back.
   * Cancellation invalidates the scan before native cleanup so late results
   * cannot publish discoveries into a replacement session.
   */
  async startScan(): Promise<void> {
    if (this._destroyed || this._connectionState !== 'disconnected') return;
    const operation = new AbortController();
    this.scanController = operation;
    this.setConnectionState('scanning');
    try {
      const nativeScan = ESPProvisionManager.searchESPDevices(
        '',
        ESPTransport.ble,
        toEspSecurity(this.config.security),
      ).then(
        (devices) => {
          // Discovery diagnostics intentionally exclude device names and data.
          log.debug('Native BLE scan result', { count: devices.length });
          return devices;
        },
        (error: unknown) => {
          log.debug('Native BLE scan rejected', {
            code: nativeErrorCode(error) ?? null,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        },
      );
      const devices = await waitForOperation(
        nativeScan,
        operation.signal,
        this.config.scanTimeoutMs,
        'BLE scan',
      );
      if (this.scanController !== operation || operation.signal.aborted) return;
      const matched = new Map<string, ESPDevice>();
      for (const device of devices) {
        if (this.matchesAnyPrefix(device.name)) matched.set(device.name, device);
      }
      for (const device of matched.values()) {
        this.emit('deviceDiscovered', { id: device.name, name: device.name, rssi: null });
      }
      this.emit('scanCompleted', { matched: matched.size, total: matched.size, sampleNames: [] });
    } catch (error) {
      if (this.scanController !== operation || operation.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      const code = nativeErrorCode(error);
      const mappedError = mapBleError(error, 'scan_error');
      // A generic SDK failure may mention both an unavailable radio/permission
      // and an empty scan. Preserve the actionable diagnosis before applying
      // the compatibility fallback for older SDKs' benign no-device errors.
      if (mappedError.code === 'scan_error' && (!code || code === 'error' || code === 'scan_failed') && /no.*device.*found|device.*not.*found/i.test(message)) {
        this.emit('scanCompleted', { matched: 0, total: 0, sampleNames: [] });
      } else if (code !== 'scan_cancelled' && code !== 'operation_cancelled') {
        this.emit('error', mappedError);
      }
      if (error instanceof OperationTimeoutError) this.stopNativeScan();
    } finally {
      if (this.scanController === operation) {
        this.scanController = null;
        this.setConnectionState('disconnected');
        this.emit('scanStopped');
      }
    }
  }

  /** Cancel immediately; stale SDK results never update a subsequent scan. */
  stopScan(): void {
    if (!this.scanController) return;
    const operation = this.scanController;
    this.scanController = null;
    operation.abort();
    this.stopNativeScan();
    if (this._connectionState === 'scanning') this.setConnectionState('disconnected');
    this.emit('scanStopped');
  }

  // ────────────────────────────────────────────────────────────────────
  // Connection
  // ────────────────────────────────────────────────────────────────────

  /**
   * Connect to a discovered device. Combines BLE link establishment with
   * the protocomm session-init handshake (Security 0/1/2 negotiation,
   * PoP / SRP exchange).
   *
   * `overrides` lets the caller supply per-flow credentials (typically
   * captured from a UI prompt) that take precedence over the values
   * configured at construction time. Useful for the `enterDeviceAuth`
   * wizard step and for unauthorized-retry flows.
   *
   * Returns a `ConnectedDeviceInfo` describing the active device. Throws
   * a `BleLibraryError` on failure.
   */
  async connect(
    deviceId: string,
    overrides?: DeviceAuthCredentials,
  ): Promise<ConnectedDeviceInfo> {
    if (this._destroyed) throw new OperationCancelledError();
    // Cancel an older scan/connection before giving native code another owner.
    void this.disconnect();
    const pop = overrides?.pop ?? this.config.proofOfPossession;
    const username = this.config.security === 2 ? overrides?.username ?? this.config.username : null;
    if (this.config.security !== 0 && pop === undefined) {
      throw new BleLibraryError('missing_credentials', 'Device authentication is required. Configure a proof-of-possession, or use an empty string for Security 1 without PoP.');
    }
    const operation = new AbortController();
    const device = new ESPDevice({ name: deviceId, transport: ESPTransport.ble, security: toEspSecurity(this.config.security) });
    this.connectController = operation;
    this.pendingDevice = device;
    this.setConnectionState('connecting');
    try {
      await waitForOperation(
        device.connect(pop ?? null, null, username),
        operation.signal,
        this.config.connectTimeoutMs,
        'BLE connection',
      );
      if (this.connectController !== operation || operation.signal.aborted) throw new OperationCancelledError();
      this.pendingDevice = null;
      this.connectController = null;
      this._device = device;
      this._connectedDeviceInfo = { id: deviceId, name: deviceId, mtu: null };
      this.setConnectionState('connected');
      return this._connectedDeviceInfo;
    } catch (error) {
      if (this.connectController === operation) {
        this.connectController = null;
        this.pendingDevice = null;
        operation.abort();
        this.stopNativeScan();
        this.disconnectNative(device);
        this.setConnectionState('disconnected');
      }
      if (error instanceof OperationCancelledError) throw error;
      throw mapBleError(error, 'connect_error');
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Disconnection
  // ────────────────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    this.stopScan();
    const pending = this.pendingDevice;
    this.pendingDevice = null;
    this.connectController?.abort();
    this.connectController = null;
    if (pending) {
      this.stopNativeScan();
      this.disconnectNative(pending);
    }
    const device = this._device;
    this._device = null;
    this._connectedDeviceInfo = null;
    if (device && device !== pending) this.disconnectNative(device);
    this.setConnectionState('disconnected');
  }

  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;
    this.unsubscribeDisconnect?.();
    this.unsubscribeDisconnect = undefined;
    await this.disconnect();
    this.removeAllListeners();
  }

  // ────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────

  /**
   * Case-insensitive prefix match, mirroring the native SDK's own
   * `name.lowercased().hasPrefix(prefix.lowercased())`. An empty configured
   * prefix matches everything.
   */
  private matchesAnyPrefix(name: string): boolean {
    const lower = name.toLowerCase();
    return this.config.deviceNamePrefixes.some((p) =>
      lower.startsWith(p.toLowerCase()),
    );
  }

  private setConnectionState(state: BleConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    this.emit('connectionStateChanged', state);
  }

  private stopNativeScan(): void {
    try { ESPProvisionManager.stopESPDevicesSearch(); } catch { /* best effort */ }
  }

  private disconnectNative(device: ESPDevice): void {
    try { device.disconnect(); } catch { /* best effort */ }
  }
}
