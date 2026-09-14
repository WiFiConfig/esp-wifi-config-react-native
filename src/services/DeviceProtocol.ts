/**
 * DeviceProtocol — Layer 2 of the ESP WiFi Config library.
 *
 * Handles the five custom protocomm endpoints registered by
 * esp_wifi_config 0.2.0+ (`esp-wifi-config-version`, `…-capabilities`,
 * `…-vars`, `…-network-policy`, `…-network-info`) plus thin wrappers
 * around the SDK's `scanWifiList()` and `provision()` so callers can stay
 * at one abstraction level.
 *
 * Custom endpoint payloads are JSON encoded as UTF-8, then sent through
 * `ESPDevice.sendData()` which handles base64 framing and protocomm
 * encryption. The SDK serialises requests internally — there is no need
 * for our own busy flag, but we still surface a `busyChanged` event for
 * UI affordances.
 */

import {
  ESPWifiAuthMode,
  type ESPWifiList,
} from '@orbital-systems/react-native-esp-idf-provisioning';

import type {
  DeviceCapabilities,
  DeviceNetworkPolicy,
  DeviceNetworkInfo,
  DeviceProtocolConfig,
  DeviceProtocolEvents,
  DeviceVariable,
  DeviceVersionInfo,
  ScannedNetwork,
  ProvisionResult,
  VarsRequest,
  VarsResponse,
  WifiAuthType,
} from '../types';

import {
  PROV_ENDPOINT_VERSION,
  PROV_ENDPOINT_CAPABILITIES,
  PROV_ENDPOINT_VARS,
  PROV_ENDPOINT_NETWORK_POLICY,
  PROV_ENDPOINT_NETWORK_INFO,
  DEFAULT_ENDPOINT_TIMEOUT_MS,
  DEFAULT_WIFI_SCAN_TIMEOUT_MS,
  DEFAULT_PROVISION_TIMEOUT_MS,
} from '../constants/protocol';

import { TypedEventEmitter, createLogger } from '../utils';
import { OperationCancelledError, OperationTimeoutError, pause, waitForOperation } from '../utils/operations';

import type { BleTransport } from './BleTransport';

const log = createLogger('DeviceProtocol');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authModeToString(mode: ESPWifiAuthMode | number): WifiAuthType {
  switch (mode) {
    case ESPWifiAuthMode.open:
      return 'OPEN';
    case ESPWifiAuthMode.wep:
      return 'WEP';
    case ESPWifiAuthMode.wpa2Enterprise:
      return 'WPA2_ENTERPRISE';
    case ESPWifiAuthMode.wpa2Psk:
      return 'WPA2';
    case ESPWifiAuthMode.wpaPsk:
      return 'WPA';
    case ESPWifiAuthMode.wpaWpa2Psk:
      return 'WPA/WPA2';
    case ESPWifiAuthMode.wpa3Psk:
      return 'WPA3';
    case ESPWifiAuthMode.wpa2Wpa3Psk:
      return 'WPA2/WPA3';
    default:
      return 'UNKNOWN';
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// DeviceProtocol
// ---------------------------------------------------------------------------

export class DeviceProtocol extends TypedEventEmitter<DeviceProtocolEvents> {
  private readonly transport: BleTransport;
  private readonly config: Required<Pick<DeviceProtocolConfig, 'defaultTimeoutMs'>> &
    Pick<DeviceProtocolConfig, 'endpointTimeouts'>;
  private inFlight = 0;
  private operationController = new AbortController();
  private destroyed = false;
  private readonly unsubscribeConnection: () => void;

  constructor(transport: BleTransport, config?: DeviceProtocolConfig) {
    super();
    this.transport = transport;
    // Starting a different native session invalidates every old request.
    this.unsubscribeConnection = transport.on('connectionStateChanged', (state) => {
      if (state === 'connecting') this.cancelPendingOperations();
    });
    this.config = {
      defaultTimeoutMs: config?.defaultTimeoutMs ?? DEFAULT_ENDPOINT_TIMEOUT_MS,
      endpointTimeouts: config?.endpointTimeouts,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API — standard endpoints (delegated to SDK)
  // ---------------------------------------------------------------------------

  /**
   * Run a Wi-Fi scan from the device. Uses the SDK's `scanWifiList()`
   * (which talks to the standard `prov-scan` protocomm endpoint).
   */
  async scanWifi(): Promise<ScannedNetwork[]> {
    const device = this.requireDevice();
    this.setBusy(true);
    try {
      const raw = await waitForOperation<ESPWifiList[]>(
        device.scanWifiList(),
        this.operationController.signal,
        DEFAULT_WIFI_SCAN_TIMEOUT_MS,
        'scanWifi',
      );
      return raw.map((n) => ({
        ssid: n.ssid,
        rssi: n.rssi,
        auth: authModeToString(n.auth),
        bssid: n.bssid,
        channel: n.channel,
      }));
    } catch (error) {
      // Native operations cannot safely be retried on the same session while
      // their timed-out callback is still outstanding. Require a new session.
      if (error instanceof OperationTimeoutError) void this.transport.disconnect();
      throw error;
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * Send credentials to the device and wait for STA-connect to complete.
   * Wraps the SDK's atomic `provision()` call (which handles the
   * `prov-config` exchange + waits for the device's STA result).
   */
  async provision(
    ssid: string,
    password: string,
    timeoutMs?: number,
  ): Promise<ProvisionResult> {
    const device = this.requireDevice();
    this.setBusy(true);
    try {
      const ms = timeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
      const resp: { status: string } = await waitForOperation(
        device.provision(ssid, password),
        this.operationController.signal,
        ms,
        'provision',
      );
      log.info('provision result:', resp.status);
      return { ssid, status: resp.status };
    } catch (error) {
      // Native operations cannot safely be retried on the same session while
      // their timed-out callback is still outstanding. Require a new session.
      if (error instanceof OperationTimeoutError) void this.transport.disconnect();
      throw error;
    } finally {
      this.setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — custom protocomm endpoints
  // ---------------------------------------------------------------------------

  /**
   * Read the firmware/library version metadata from
   * `esp-wifi-config-version`.
   */
  async getVersion(): Promise<DeviceVersionInfo> {
    return this.readJsonEndpoint<DeviceVersionInfo>(PROV_ENDPOINT_VERSION);
  }

  /**
   * Read the device's enabled feature flags + storage limits from
   * `esp-wifi-config-capabilities`.
   */
  async getCapabilities(): Promise<DeviceCapabilities> {
    return this.readJsonEndpoint<DeviceCapabilities>(
      PROV_ENDPOINT_CAPABILITIES,
    );
  }

  /**
   * Read the device's effective provisioning policy (mode + retries).
   */
  async getNetworkPolicy(): Promise<DeviceNetworkPolicy> {
    return this.readJsonEndpoint<DeviceNetworkPolicy>(
      PROV_ENDPOINT_NETWORK_POLICY,
    );
  }

  /**
   * Read the station's assigned network details (IP, gateway, RSSI, …) from
   * `esp-wifi-config-network-info`. Call right after a successful provision(),
   * while the BLE link is still up — the device tears down provisioning once
   * the client disconnects.
   *
   * One round-trip. May report `{ connected: false }` if GOT_IP hasn't landed
   * yet; use {@link waitForNetworkInfo} to poll until the IP is assigned.
   */
  async getNetworkInfo(): Promise<DeviceNetworkInfo> {
    return this.readJsonEndpoint<DeviceNetworkInfo>(PROV_ENDPOINT_NETWORK_INFO);
  }

  /**
   * Best-effort network details with one total deadline (default 3000 ms).
   * Cancellation or transport loss stops retries. A missing result never
   * turns an already-confirmed successful provision into failure.
   * @example await protocol.waitForNetworkInfo(3, 500, { timeoutMs: 2000 });
   */
  async waitForNetworkInfo(
    attempts = 3,
    intervalMs = 500,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<DeviceNetworkInfo | null> {
    const deadline = Date.now() + (options.timeoutMs ?? 3000);
    const session = this.operationController.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    session.addEventListener('abort', abort);
    options.signal?.addEventListener('abort', abort);
    if (session.aborted || options.signal?.aborted) controller.abort();
    let last: DeviceNetworkInfo | null = null;
    try {
      for (let i = 0; i < attempts; i++) {
        if (controller.signal.aborted || !this.transport.isConnected || Date.now() >= deadline) break;
        try {
          last = await this.sendJson<DeviceNetworkInfo>(PROV_ENDPOINT_NETWORK_INFO, undefined, {
            signal: controller.signal,
            timeoutMs: Math.max(0, deadline - Date.now()),
          });
          if (last.connected) return last;
        } catch (error) {
          // A timed-out native request can still own the response callback.
          // Do not overlap it with another optional request on this session.
          if (error instanceof OperationCancelledError || error instanceof OperationTimeoutError || !this.transport.isConnected) break;
          log.debug('Optional network info unavailable:', toMessage(error));
        }
        if (i < attempts - 1 && Date.now() < deadline) {
          await pause(Math.min(intervalMs, deadline - Date.now()), controller.signal);
        }
      }
    } catch (error) {
      if (!(error instanceof OperationCancelledError)) log.debug('Network info stopped:', toMessage(error));
    } finally {
      session.removeEventListener('abort', abort);
      options.signal?.removeEventListener('abort', abort);
    }
    return last;
  }

  // ---- Custom variable store ------------------------------------------------

  /** List every saved variable. */
  async listVars(): Promise<DeviceVariable[]> {
    const resp = await this.callVars({ op: 'list' });
    if ('error' in resp) throw new Error(resp.error);
    if ('vars' in resp) {
      return resp.vars.map((v) => ({ key: v.k, value: v.v }));
    }
    return [];
  }

  /** Read a single variable. Returns `null` if it doesn't exist. */
  async getVar(key: string): Promise<DeviceVariable | null> {
    const resp = await this.callVars({ op: 'get', key });
    if ('error' in resp) {
      if (resp.error === 'not_found') return null;
      throw new Error(resp.error);
    }
    if ('value' in resp) {
      return { key: resp.key, value: resp.value };
    }
    return null;
  }

  /** Set (insert or update) a variable. */
  async setVar(key: string, value: string): Promise<void> {
    const resp = await this.callVars({ op: 'set', key, value });
    if ('error' in resp) throw new Error(resp.error);
  }

  /** Delete a variable. */
  async delVar(key: string): Promise<void> {
    const resp = await this.callVars({ op: 'del', key });
    if ('error' in resp) throw new Error(resp.error);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Cancel current requests without disposing the reusable protocol instance. */
  cancelPendingOperations(): void {
    this.operationController.abort();
    this.operationController = new AbortController();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribeConnection();
    this.cancelPendingOperations();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireDevice() {
    if (this.destroyed) throw new OperationCancelledError();
    const device = this.transport.espDevice;
    if (!device) {
      throw new Error('No device connected');
    }
    return device;
  }

  private setBusy(busy: boolean): void {
    if (busy) {
      this.inFlight++;
    } else {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
    this.emit('busyChanged', this.inFlight > 0);
  }

  private resolveTimeout(endpoint: string): number {
    return (
      this.config.endpointTimeouts?.[endpoint] ?? this.config.defaultTimeoutMs
    );
  }

  /**
   * Call a custom protocomm endpoint with a JSON request and parse a JSON
   * response. The SDK's `sendData()` takes/returns base64 strings — we
   * encode the request body and decode the response.
   */
  private async sendJson<TRes>(
    endpoint: string,
    body: unknown,
    options?: { signal: AbortSignal; timeoutMs: number },
  ): Promise<TRes> {
    const device = this.requireDevice();
    const ms = Math.min(this.resolveTimeout(endpoint), options?.timeoutMs ?? Infinity);
    // IMPORTANT: never send a zero-length payload. The ESP32 protocomm BLE
    // transport does not dispatch an empty write to its endpoint handler, so
    // the device produces no response and the read returns empty (the call
    // then times out / throws "Empty response"). The read-only custom
    // endpoints (version/capabilities/network-policy) ignore the body but
    // still need at least one byte — send "{}" for an empty request.
    // (Hardware-verified; see bluetooth_spec.md §12 and §18.5.)
    //
    // Do NOT base64-encode here. `ESPDevice.sendData()` already base64-encodes
    // the request and base64-decodes the response internally — it takes and
    // returns plain UTF-8 strings. Encoding ourselves would double-encode: the
    // device would receive base64 *text* instead of JSON (→ firmware
    // "bad_json"), and the response would be a still-base64 string we'd then
    // mangle by decoding twice.
    const requestStr = body === undefined ? '{}' : JSON.stringify(body);

    this.setBusy(true);
    try {
      const responseStr: string = await waitForOperation(
        device.sendData(endpoint, requestStr),
        options?.signal ?? this.operationController.signal,
        ms,
        endpoint,
      );

      if (!responseStr || !responseStr.trim()) {
        throw new Error(`Empty response from ${endpoint}`);
      }

      try {
        return JSON.parse(responseStr.trim()) as TRes;
      } catch (err) {
        // Surface the raw payload (truncated) so the actual bytes on the wire
        // are diagnosable, not just the parser's complaint about one character.
        const snippet =
          responseStr.length > 160
            ? `${responseStr.slice(0, 160)}…(${responseStr.length})`
            : responseStr;
        throw new Error(
          `Invalid JSON response from ${endpoint}: ${
            err instanceof Error ? err.message : String(err)
          } | raw=${JSON.stringify(snippet)}`,
          { cause: err },
        );
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (err instanceof OperationCancelledError) throw err;
      if (err instanceof OperationTimeoutError && !options) void this.transport.disconnect();
      log.debug(`Endpoint ${endpoint} failed:`, error.message);
      this.emit('endpointError', error, endpoint);
      throw error;
    } finally {
      this.setBusy(false);
    }
  }

  /** Convenience: GET-style call that sends an empty body and parses JSON. */
  private readJsonEndpoint<T>(endpoint: string): Promise<T> {
    return this.sendJson<T>(endpoint, undefined);
  }

  private async callVars(req: VarsRequest): Promise<VarsResponse> {
    const resp = await this.sendJson<VarsResponse>(PROV_ENDPOINT_VARS, req);
    // Surface firmware-side rejections. `not_found` / `missing_key` are
    // normal control-flow for get/del and stay quiet; everything else
    // (`rejected`, `store_full`, `missing_key_or_value`, `unknown_op`, …)
    // means the device refused the operation — log it, since otherwise the
    // reason is buried inside the Error thrown by the caller.
    if (
      'error' in resp &&
      resp.error !== 'not_found' &&
      resp.error !== 'missing_key'
    ) {
      const op = 'op' in req ? req.op : '?';
      log.warn(`vars op=${op} rejected by device: ${resp.error}`);
    }
    return resp;
  }
}
