/**
 * BLE-related types for ESP-IDF Network Provisioning.
 *
 * The transport wraps `@orbital-systems/react-native-esp-idf-provisioning`
 * (which in turn wraps Espressif's native iOS / Android SDKs). The native
 * layer does the BLE I/O, so there is no live discovery stream, no GATT
 * writes from JS, and no JSON reassembly at this level — the events below
 * model what the SDK actually surfaces.
 */

export type BleErrorCode =
  | 'unauthorized'
  /**
   * `connect()` was called for Security 1/2 with no PoP configured and none
   * supplied. Only reachable headless — the wizard inserts `enterDeviceAuth`
   * first. Pass `''` for a Security 1 device that runs without a PoP.
   */
  | 'missing_credentials'
  | 'bluetooth_unauthorized'
  | 'session_init_failed'
  | 'security_mismatch'
  | 'connect_timeout'
  | 'operation_cancelled'
  | 'powered_off'
  | 'unsupported'
  | 'scan_error'
  | 'connect_error'
  | 'provision_error'
  | 'unknown';

export class BleLibraryError extends Error {
  readonly code: BleErrorCode;

  constructor(code: BleErrorCode, message: string) {
    super(message);
    this.name = 'BleLibraryError';
    this.code = code;
  }
}

export type BleConnectionState =
  | 'disconnected'
  | 'scanning'
  | 'connecting'
  | 'connected';

/**
 * A device found by the SDK during a scan. The `id` is whatever the SDK
 * returns (BLE peripheral identifier on iOS, MAC address on Android), and
 * `name` is the GAP-advertised name (typically `PROV_xxxxxx`).
 */
export interface DiscoveredDevice {
  id: string;
  /** Advertised device name, e.g. "PROV_AB12CD" */
  name: string;
  /**
   * RSSI at discovery time. The native SDK does not always surface this;
   * `null` when unknown.
   */
  rssi: number | null;
}

export interface ConnectedDeviceInfo {
  id: string;
  name: string;
  /**
   * Reported negotiated MTU, when the platform surfaces it. The native SDK
   * manages MTU internally and does not expose it, so this is `null` there.
   */
  mtu: number | null;
}

/** Diagnostic info emitted by `BleTransport` after a scan completes. */
export interface ScanCompletedInfo {
  /** Number of devices that matched the configured name prefix(es). */
  matched: number;
  /**
   * Total number of unique devices observed during the scan. The native
   * SDK only surfaces matched devices, so `total` always equals `matched`.
   */
  total: number;
  /**
   * Sample of matched device names, for diagnostics. The native SDK
   * transport does not populate this, so it is empty there.
   */
  sampleNames: string[];
}

export interface BleTransportEvents {
  connectionStateChanged: (state: BleConnectionState) => void;
  /**
   * Emitted once per matched device after the SDK scan completes. The SDK
   * does not stream individual discoveries — devices land in the store
   * as a batch.
   */
  deviceDiscovered: (device: DiscoveredDevice) => void;
  /** Fires once per scan cycle when results are in (or timeout fires). */
  scanCompleted: (info: ScanCompletedInfo) => void;
  scanStopped: () => void;
  /** Emitted only for genuine failures (BLE off, unauthorized, scan_error). */
  error: (error: Error) => void;
}

/**
 * Security version selector. Maps onto the SDK's `ESPSecurity` enum and
 * the firmware's runtime `wifi_cfg_prov_config_t.security` field
 * (`WIFI_CFG_PROV_SECURITY_0/1/2`; the firmware's `DEFAULT` resolves to 1).
 */
export type SecurityVersion = 0 | 1 | 2;

export interface BleTransportConfig {
  /** Device name prefix(es) to filter during scanning. Default: `"PROV_"`. */
  deviceNamePrefix?: string | string[];
  /** Scan timeout in ms. Default: 10000. */
  scanTimeoutMs?: number;
  /** Entire discovery + handshake timeout in ms. Default: 20000. */
  connectTimeoutMs?: number;
  /**
   * Security version used during the protocomm session.
   * Default: 1 (matches the firmware's default).
   */
  security?: SecurityVersion;
  /**
   * Proof-of-possession (Security 1) or SRP password (Security 2). There is
   * no default; the three states mean different things:
   *
   *   - `undefined` — not configured. The wizard inserts `enterDeviceAuth` so
   *     the user types it; a headless `connect()` throws `missing_credentials`.
   *   - `''` — the device runs Security 1 **with no PoP** (the firmware's own
   *     default when `prov_ble.pop` is unset). Connects without prompting.
   *   - any other string — used as-is. The firmware repo's `examples/with_ble`
   *     uses `'abcd1234'`, exported here as `DEFAULT_POP` for convenience.
   *
   * Ignored for Security 0.
   */
  proofOfPossession?: string;
  /**
   * SRP6a username for Security 2. Must be the username the device's
   * salt + verifier were derived from. Default: `"wificfg"` (again the
   * `examples/with_ble` value — the firmware itself has no default).
   */
  username?: string;
  /**
   * Force the wizard to insert an `enterDeviceAuth` step where the user
   * enters the PoP (sec1) or SRP password + username (sec2) before
   * connecting. When false (the default), the configured values above
   * are used as-is and the auth step is skipped — unless the required
   * fields are missing or a previous connect attempt was rejected as
   * `unauthorized`, in which case the auth step is inserted regardless.
   * Has no effect when `security === 0`.
   */
  promptForAuth?: boolean;
}

/**
 * Per-flow auth credentials submitted from the `enterDeviceAuth` screen.
 * Override the config-level defaults for one connect attempt.
 */
export interface DeviceAuthCredentials {
  /** PoP (sec1) or SRP password (sec2). */
  pop?: string;
  /** SRP6a username (sec2 only). */
  username?: string;
}
