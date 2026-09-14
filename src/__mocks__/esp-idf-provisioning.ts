/**
 * Jest mock for `@orbital-systems/react-native-esp-idf-provisioning`.
 *
 * Tests don't care about the real native bridge — they just want a stable
 * stub for the methods our services call. Override the `mock_*` hooks
 * exposed below from individual tests to script per-test behaviour.
 */

export enum ESPTransport {
  ble = 'ble',
  softap = 'softap',
}

export enum ESPSecurity {
  unsecure = 0,
  secure = 1,
  secure2 = 2,
}

export enum ESPWifiAuthMode {
  open = 0,
  wep = 1,
  wpa2Enterprise = 2,
  wpa2Psk = 3,
  wpaPsk = 4,
  wpaWpa2Psk = 5,
  wpa3Psk = 6,
  wpa2Wpa3Psk = 7,
}

export interface ESPWifiList {
  ssid: string;
  rssi: number;
  auth: ESPWifiAuthMode;
  bssid?: string;
  channel?: number;
}

export interface ESPStatusResponse {
  status: string;
}

interface MockHooks {
  disconnect?: (name: string) => void;
  stopSearch?: () => void;
  search?: (prefix: string) => ESPDevice[] | Promise<ESPDevice[]>;
  connect?: (name: string, pop: string | null) => void | Promise<void>;
  scanWifi?: () => ESPWifiList[] | Promise<ESPWifiList[]>;
  provision?: (ssid: string, password: string) => ESPStatusResponse | Promise<ESPStatusResponse>;
  sendData?: (path: string, data: string) => string | Promise<string>;
}

export const mockHooks: MockHooks = {};

export class ESPDevice {
  name: string;
  transport: ESPTransport;
  security: ESPSecurity;
  connected = false;

  constructor({
    name,
    transport,
    security,
  }: {
    name: string;
    transport: ESPTransport;
    security: ESPSecurity;
  }) {
    this.name = name;
    this.transport = transport;
    this.security = security;
  }

  async connect(
    proofOfPossession?: string | null,
    _softAPPassword?: string | null,
    _username?: string | null,
  ): Promise<void> {
    if (mockHooks.connect) await mockHooks.connect(this.name, proofOfPossession ?? null);
    this.connected = true;
  }

  // Mirrors orbital's ESPDevice.sendData: raw string in, raw string out. The
  // real implementation base64-encodes the request and base64-decodes the
  // response *internally*, so callers (DeviceProtocol) must pass/receive plain
  // UTF-8 — never pre-base64. Keep this a passthrough so tests catch
  // double-encoding regressions.
  async sendData(path: string, data: string): Promise<string> {
    if (mockHooks.sendData) return mockHooks.sendData(path, data);
    return '';
  }

  async scanWifiList(): Promise<ESPWifiList[]> {
    return mockHooks.scanWifi ? mockHooks.scanWifi() : [];
  }

  disconnect(): void {
    mockHooks.disconnect?.(this.name);
    this.connected = false;
  }

  async provision(ssid: string, passphrase: string): Promise<ESPStatusResponse> {
    if (mockHooks.provision) return mockHooks.provision(ssid, passphrase);
    return { status: 'success' };
  }

  async getProofOfPossession() {
    return undefined;
  }
  async setProofOfPossession() {
    return this;
  }
  async getUsername() {
    return undefined;
  }
  async setUsername() {
    return this;
  }
  async getDeviceName() {
    return this.name;
  }
  async setDeviceName() {
    return this;
  }
  async getPrimaryServiceUuid() {
    return undefined;
  }
  async setPrimaryServiceUuid() {
    return this;
  }
  async getSecurityType() {
    return this.security;
  }
  async setSecurityType() {
    return this;
  }
  async getTransportType() {
    return this.transport;
  }
  async getVersionInfo() {
    return undefined;
  }
  async getDeviceCapabilities() {
    return undefined;
  }
}

export class ESPProvisionManager {
  static async searchESPDevices(
    prefix: string,
    _transport: ESPTransport,
    _security: ESPSecurity,
  ): Promise<ESPDevice[]> {
    return mockHooks.search ? mockHooks.search(prefix) : [];
  }
  static stopESPDevicesSearch(): void {
    mockHooks.stopSearch?.();
  }
}

export type ESPDeviceInterface = ESPDevice;

const disconnectListeners = new Set<(event: { deviceName: string; reason?: string }) => void>();

export function addDeviceDisconnectListener(listener: (event: { deviceName: string; reason?: string }) => void): () => void {
  disconnectListeners.add(listener);
  return () => { disconnectListeners.delete(listener); };
}

export function emitMockDeviceDisconnect(deviceName: string): void {
  for (const listener of disconnectListeners) listener({ deviceName });
}
