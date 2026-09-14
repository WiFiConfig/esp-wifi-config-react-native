# API Reference

Exhaustive reference for every exported symbol in `esp-wifi-config-react-native`. Every entry has a one-paragraph description plus an example. The TypeScript types in `src/types/` are the source of truth; this document mirrors them.

For a full runnable app see [example_app/](./example_app/); for focused snippets see [examples/](./examples/). For task-oriented walkthroughs see [GUIDES/](./GUIDES/). For the mental model and pitfalls see [CLAUDE.md](./CLAUDE.md).

## Core hooks

### `useProvisioning()`

Primary wizard hook. Returns every piece of provisioning state plus every action verb.

```ts
const {
  // State
  step, stepNumber, error, lastResult, lastProvisionResult,
  device, scannedNetworks, selectedNetwork,
  authMode, defaultAuthValues, pendingAuth,
  // Actions
  start, chooseDevice, submitDeviceAuth, proceedFromConfigure, rescanWifi,
  chooseNetwork, backToNetworks, submitPassword,
  retryJoin, pickDifferentNetwork, pickDifferentDevice, cancel,
} = useProvisioning();
```

State fields are reactive (re-render on change). Action verbs are stable references.

`@see` `ProvisioningStep`, `ProvisioningError`, `DeviceConnection`, `ProvisioningResult`, `DeviceAuthMode`.

### `useDeviceScanner()`

Thin selector over BLE scan state. Returns `discoveredDevices`, `scanning`, `lastScanResult`. Use when you only need the device list and not the full wizard.

```ts
const { discoveredDevices, scanning, lastScanResult } = useDeviceScanner();
```

### `useBleConnection()`

Thin selector over the unified `device` shape.

```ts
const { device } = useBleConnection();
if (device?.status === 'connected') { /* ... */ }
```

### `useDeviceProtocol()`

Direct access to every device command, with per-instance `loading` and `error`. Backed by the five custom protocomm endpoints (`esp-wifi-config-version`, `-capabilities`, `-vars`, `-network-policy`, `-network-info`) plus the SDK's `scanWifiList()` and `provision()`.

```ts
const {
  scanWifi, provision,
  getVersion, getCapabilities, getNetworkPolicy,
  listVars, getVar, setVar, delVar,
  loading, error,
} = useDeviceProtocol();
```

Each method throws on failure. `loading` is true while ANY call from this hook instance is in flight.

### `useDeviceVariables()`

Convenience hook for `get_var`/`set_var`/`list_vars`/`del_var`. Returns `null`/`false` on error rather than throwing.

```ts
const { getVariable, setVariable, listVariables, deleteVariable, loading, error } = useDeviceVariables();
const v = await getVariable('mdns_name');          // DeviceVariable | null
const ok = await setVariable('mdns_name', 'foo');  // boolean
```

`@see` `GUIDES/04-pre-wifi-customization.md` for a full hostname-editor recipe.

## Pre-built navigator

### `ProvisioningNavigator`

Drop-in wizard. Imported from `esp-wifi-config-react-native/navigation` to avoid forcing `@react-navigation` deps on hooks-only consumers.

```tsx
import { ProvisioningNavigator } from 'esp-wifi-config-react-native/navigation';

<ProvisioningNavigator
  config={{ ble: { deviceNamePrefix: 'PROV_', security: 1, proofOfPossession: 'abcd1234' } }}
  onComplete={(result) => router.push(`/devices/${result.deviceId}`)}
  onDismiss={() => router.back()}
  theme={{ colors: { primary: '#6366F1' } }}
/>
```

Mounts an isolated `NavigationIndependentTree`. Safe inside Expo Router or any existing navigator.

Props:
| Prop | Type | Description |
|------|------|------|
| `config` | `ProvisioningConfig` | BLE / protocol / flow options |
| `onComplete` | `(result: ProvisioningResult) => void` | Fires once when provisioning succeeds |
| `onDismiss` | `() => void` | User pressed Close on welcome |
| `theme` | `ProvisioningTheme` | Visual customization |

## Pre-built screens

| Screen | Renders steps | Props |
|------|------|------|
| `WelcomeScreen` | welcome | `theme?` |
| `ConnectScreen` | scanBle, connectingBle | `theme?` |
| `DeviceAuthScreen` | enterDeviceAuth | `theme?` |
| `ConfigureScreen` | configuring | `theme?` |
| `NetworkScanScreen` | scanningWifi, chooseNetwork | `theme?` |
| `CredentialsScreen` | enterCredentials | `theme?`, `onGoBack?` |
| `ConnectingScreen` | joiningWifi | `theme?` |
| `SuccessScreen` | success | `theme?`, `onComplete?` |

All screens consume `useProvisioning()` internally. Compose freely with custom screens if you want a hybrid wizard.

## Pre-built components

`ErrorBanner`, `LoadingSpinner`, `SignalIcon`, `StepIndicator`, `PasswordInput`, `ConfirmDialog`, `NetworkList`, `NetworkListItem`, `VariableEditor`, `DeviceListItem`. Each accepts a `theme?: ProvisioningTheme` prop.

## Service classes

### `BleTransport`

Layer 1. Wraps the native ESP-IDF Provisioning SDK — scanning, connecting (incl. protocomm session-init), disconnecting.

```ts
const transport = new BleTransport({
  deviceNamePrefix: 'PROV_',
  security: 1,
  proofOfPossession: 'abcd1234',
});
transport.on('deviceDiscovered', d => { /* ... */ });
await transport.startScan();
await transport.connect(deviceId);
// For per-device credentials, pass overrides as the second arg:
//   await transport.connect(deviceId, { pop, username });
await transport.disconnect();
await transport.destroy();
```

Events: `connectionStateChanged`, `deviceDiscovered`, `scanCompleted`, `scanStopped`, `error`.

Notable methods:
- `startScan(): Promise<void>` — runs one match-all `searchESPDevices()` call, filters all configured prefixes, and emits one `deviceDiscovered` per match.
- `stopScan(): void` — cancels an in-flight scan.
- `connect(deviceId, overrides?: { pop?, username? }): Promise<ConnectedDeviceInfo>` — establishes the BLE link plus protocomm session.
- `disconnect(): Promise<void>` — clean teardown.
- `destroy(): Promise<void>` — full teardown + remove listeners.
- Getters: `isConnected`, `connectedDevice`, `connectionState`, `espDevice`, `resolvedConfig`.

### `DeviceProtocol`

Layer 2. SDK's atomic `provision()` + `scanWifiList()` plus JSON-over-base64 wrappers for the five custom protocomm endpoints.

```ts
const protocol = new DeviceProtocol(transport);
const networks = await protocol.scanWifi();
const r = await protocol.provision(ssid, password);   // ProvisionResult
const v = await protocol.getVersion();
await protocol.setVar('mdns_name', 'demo');
```

Methods: `scanWifi`, `provision`, `getVersion`, `getCapabilities`, `getNetworkPolicy`, `getNetworkInfo`, `waitForNetworkInfo(attempts = 3, intervalMs = 500, options?: { timeoutMs?: number; signal?: AbortSignal })`, `listVars`, `getVar`, `setVar`, `delVar`, `cancelPendingOperations`, `destroy`. Emits `busyChanged` and `endpointError`.

`getNetworkInfo()` reads `esp-wifi-config-network-info` once and may return `{ connected: false }` before the device has an IP. `waitForNetworkInfo()` polls it until `connected` is true or the attempts run out; it never throws and resolves `null` if every attempt failed (firmware < 0.2.0, or BLE already dropped). One deadline includes every request and retry delay (`timeoutMs`, default 3000 ms). Cancellation and BLE loss stop further retries. Native scan/provision/custom-command timeouts disconnect the stalled session before another attempt; optional network-info expiration does not fail the successful result.

### `ProvisioningManager`

Layer 3. Wizard state machine. Used internally by the store; useful for headless integration tests.

```ts
const manager = new ProvisioningManager(transport, protocol, config);
manager.on('stepChanged', step => { /* ... */ });
manager.on('provisioningComplete', result => { /* confirmed success, exactly once */ });
manager.on('provisioningResultUpdated', result => { /* optional networkInfo enrichment */ });
await manager.start();
await manager.chooseDevice({ id, name, rssi });
// If sec1/2 with promptForAuth: true or missing credentials:
await manager.submitDeviceAuth({ pop, username });
manager.chooseNetwork(network);
await manager.submitPassword(password);
```

Public methods: `start`, `chooseDevice`, `submitDeviceAuth`, `proceedFromConfigure`, `rescanWifi`, `chooseNetwork`, `backToNetworks`, `submitPassword`, `retryJoin`, `pickDifferentNetwork`, `pickDifferentDevice`, `cancel`, `destroy`. Getters: `currentStep`, `selectedNetwork`, `scannedNetworks`, `device`, `error`, `pendingAuth`.

`provisioningComplete` is emitted with stable device identity and SSID before entering `success`. `submitPassword()` resolves without waiting for optional details. The store publishes this initial result immediately, then updates `lastResult` when `provisioningResultUpdated` arrives. Cancellation/restart suppresses stale results and aborts `onConnected`'s `signal`. Consumers should not treat an update to `lastResult` as a new completion.

## Service factory (singleton access)

```ts
import {
  initializeServices, destroyServices,
  getTransport, getProtocol, getManager,
} from 'esp-wifi-config-react-native';

initializeServices({ ble: { deviceNamePrefix: 'PROV_' } });
const t = getTransport();
await destroyServices();
```

Idempotent — calling `initializeServices` while services exist is a no-op. Call `destroyServices()` first to force re-creation with new config.

## Store

### `useProvisioningStore`

Zustand store. Hooks select from this. Tests can `useProvisioningStore.setState({...})` to override state directly.

Exported types: `ProvisioningStoreState`, `ProvisioningStoreActions`, `DeviceAuthMode`. See `src/store/provisioningStore.ts`.

## Utilities

### `requestBluetoothPermissions()`

Runtime permission helper. Always call before `start()` on Android.

```ts
const r = await requestBluetoothPermissions();
// { granted: true } | { granted: false, reason: 'denied' | 'never_ask_again' }
```

### `setLogLevel(level)`

Library-wide log verbosity. Levels: `'debug' | 'info' | 'warn' | 'error' | 'none'`. Default: `'warn'`.

```ts
import { setLogLevel } from 'esp-wifi-config-react-native';
setLogLevel('debug');
```

## Types

### `ProvisioningStep`

```ts
type ProvisioningStep =
  | 'welcome'
  | 'scanBle' | 'enterDeviceAuth' | 'connectingBle'
  | 'configuring'
  | 'scanningWifi' | 'chooseNetwork'
  | 'enterCredentials' | 'joiningWifi'
  | 'success';
```

### `ProvisioningError`

```ts
type ProvisioningError = {
  source: 'ble' | 'protocol' | 'provision' | 'flow';
  code?: string;
  message: string;
  recoverable: boolean;
};
```

`@see` `GUIDES/05-error-handling.md`.

### `DeviceConnection`

```ts
type DeviceConnection =
  | null
  | { status: 'connecting'; id: string; name: string; rssi: number | null }
  | { status: 'connected'; id: string; name: string; mtu: number | null };
```

`mtu` is always `null` — the native SDK manages MTU internally and doesn't surface it.

### `ProvisioningResult`

```ts
type ProvisioningResult = {
  success: boolean;
  ssid?: string;
  /** Raw status string from the SDK's provision(); typically "success". */
  provisionStatus?: string;
  deviceName?: string;
  deviceId?: string;
  /**
   * Station details read from `esp-wifi-config-network-info` right after
   * provisioning, while BLE is still up. Best-effort: undefined if the fetch
   * failed (firmware < 0.2.0, BLE dropped first); `{ connected: false }` if
   * the IP had not landed within the retry window.
   */
  networkInfo?: DeviceNetworkInfo;
};
```

The SDK's `provision()` does not return the device's IP; the manager fills `networkInfo` from the firmware endpoint instead (see `DeviceNetworkInfo`). If it is absent, fall back to mDNS or the firmware's HTTP API once the device is on the network.

### `ProvisionResult`

```ts
type ProvisionResult = {
  ssid: string;
  /** SDK provision() return — typically "success". */
  status: string;
};
```

### `ProvisioningConfig`

```ts
type ProvisioningConfig = {
  ble?: BleTransportConfig;
  protocol?: DeviceProtocolConfig;
  flow?: {
    onConnected?: (ctx: OnConnectedContext) => Promise<void>;
    autoConnectOpenNetworks?: boolean;     // default true
    provisionTimeoutMs?: number;           // default 60_000
    networkInfoTimeoutMs?: number;          // default 3_000, total enrichment budget
  };
};
```

### `BleTransportConfig`

```ts
type BleTransportConfig = {
  deviceNamePrefix?: string | string[];   // default 'PROV_'
  scanTimeoutMs?: number;                  // default 10_000
  connectTimeoutMs?: number;               // default 20_000, includes discovery + handshake
  security?: 0 | 1 | 2;                    // default 1
  proofOfPossession?: string;              // sec1 PoP / sec2 SRP password — no default, see below
  username?: string;                       // sec2 only, default 'wificfg'
  promptForAuth?: boolean;                 // default false — force enterDeviceAuth step
};
```

`proofOfPossession` has no default. Unset → the wizard inserts `enterDeviceAuth` and a headless `connect()` throws `BleLibraryError('missing_credentials')`. `''` → the device runs Security 1 with no PoP (the firmware's own default when `prov_ble.pop` is unset) and connects without prompting. Any other string is used as-is; `DEFAULT_POP` (`'abcd1234'`) is the firmware repo's `examples/with_ble` value for apps that want to name it explicitly. The `username` default likewise mirrors `examples/with_ble` — the firmware has no username default; it must be whatever the Security 2 salt + verifier were derived from.

### `DeviceProtocolConfig`

```ts
type DeviceProtocolConfig = {
  defaultTimeoutMs?: number;              // default 8_000
  endpointTimeouts?: Record<string, number>;
};
```

### `DeviceAuthCredentials`

```ts
type DeviceAuthCredentials = {
  pop?: string;       // sec1 PoP / sec2 SRP password
  username?: string;  // sec2 only
};
```

### `DeviceAuthMode`

```ts
type DeviceAuthMode = 'pop' | 'srp' | null;
```

Derived from `ble.security`. `null` when sec0 (the auth screen never shows). Surfaced via `useProvisioning().authMode`.

### `OnConnectedContext`

```ts
type OnConnectedContext = {
  protocol: DeviceProtocol;
  transport: BleTransport;
};
```

### `ProvisioningTheme`

```ts
type ProvisioningTheme = {
  colors?: {
    primary?, primaryText?, background?, card?, text?,
    textSecondary?, border?, error?, success?, warning?: string;
  };
  borderRadius?: number;
};
```

### `ScanCompletedInfo`

```ts
type ScanCompletedInfo = {
  matched: number;       // devices matching deviceNamePrefix
  total: number;         // SDK only returns matches, so total === matched
  sampleNames: string[]; // empty on the SDK transport (not populated by the native layer)
};
```

### `DeviceVersionInfo` / `DeviceCapabilities` / `DeviceNetworkPolicy` / `DeviceNetworkInfo` / `DeviceVariable`

Typed responses from the five custom protocomm endpoints. See `src/types/protocol.ts`.

- `DeviceVersionInfo.lib` is hardcoded to `"esp_wifi_config 0.1.0"` in firmware 0.1.0–0.2.3 regardless of the real component version — gate on `fw_version` / `firmware_version` instead.
- `DeviceCapabilities.capabilities` is `Array<DeviceCapability | string>`; known flags are `'multi-network' | 'custom-vars' | 'improv-serial' | 'webui' | 'cli' | 'softap'`.
- `DeviceNetworkPolicy.provisioning_mode` is `DeviceProvisioningMode | string` — `'always' | 'on_failure' | 'when_unprovisioned' | 'manual' | 'unknown'`. The firmware sends the name, never the enum number.
- `DeviceNetworkInfo` is `{ connected: boolean; ip?, netmask?, gateway?, dns?, mac?, bssid?, hostname?, ssid?, rssi?, quality?, channel?, uptime_ms? }`; when `connected` is false the rest is absent.

### `BleLibraryError`

Extends `Error`. Thrown by BLE-level operations.

```ts
type BleErrorCode =
  | 'unauthorized' | 'missing_credentials' | 'powered_off' | 'unsupported'
  | 'scan_error' | 'connect_error' | 'provision_error' | 'unknown';
```

```ts
import { BleLibraryError } from 'esp-wifi-config-react-native';
try { await transport.connect(id); }
catch (err) {
  if (err instanceof BleLibraryError && err.code === 'unauthorized') { /* ... */ }
}
```

## Constants

| Constant | Value |
|------|------|
| `DEVICE_NAME_PREFIX` | `'PROV_'` (matches the firmware's `prov_ble.device_name` default `"PROV_{id}"`) |
| `DEFAULT_POP` | `'abcd1234'` — the `examples/with_ble` value. **Not applied implicitly**; pass it explicitly if you want it |
| `DEFAULT_SECURITY2_USERNAME` | `'wificfg'` (matches `examples/with_ble`; the firmware has no default) |
| `DEFAULT_SCAN_TIMEOUT_MS` | `10_000` |
| `DEFAULT_ENDPOINT_TIMEOUT_MS` | `8_000` |
| `DEFAULT_WIFI_SCAN_TIMEOUT_MS` | `15_000` |
| `DEFAULT_PROVISION_TIMEOUT_MS` | `60_000` |
| `PROV_ENDPOINT_VERSION` | `'esp-wifi-config-version'` |
| `PROV_ENDPOINT_CAPABILITIES` | `'esp-wifi-config-capabilities'` |
| `PROV_ENDPOINT_VARS` | `'esp-wifi-config-vars'` |
| `PROV_ENDPOINT_NETWORK_POLICY` | `'esp-wifi-config-network-policy'` |
| `PROVISIONING_STEP_ORDER` | Array of every step in canonical traversal order |
| `STEP_NUMBERS` | `Record<ProvisioningStep, number \| null>` |
| `VISIBLE_STEP_COUNT` | `5` |

## Helpers

| Function | Returns |
|------|------|
| `stepNumber(step)` | `number \| null` — 1..5 user-visible step number |
| `stepToScreenName(step)` | `ScreenName` for the pre-built navigator |

## Navigation utilities

```ts
import { SCREEN_NAMES, stepToScreenName } from 'esp-wifi-config-react-native';
type ScreenName = (typeof SCREEN_NAMES)[keyof typeof SCREEN_NAMES];
```

Screen names: `Welcome`, `Connect`, `DeviceAuth`, `Configure`, `NetworkScan`, `Credentials`, `Joining`, `Success`.

## Screen lifecycle and cancellation

Use `useProvisioningStore.getState().initialize(config)` when the custom wizard mounts and `await useProvisioningStore.getState().destroy()` when it is permanently released. `cancel()` resets the current run and preserves the last successful result; it can be reused for another device. `destroy()` removes subscriptions and resets the store, and is safe to call again. A replacement session cannot receive callbacks from the discarded run.

`OnConnectedContext` includes a required `signal: AbortSignal`. Register abort cleanup for a custom screen gate and check `signal.aborted` after awaited reads before updating that screen. The manager stops awaiting the callback as soon as the run is cancelled, even when application code ignores the signal.

```ts
flow: {
  onConnected: async ({ protocol, signal }) => {
    const name = await protocol.getVar('mdns_name');
    if (signal.aborted) return;
    await showHostnameEditor(name?.value ?? '', signal);
  },
}
```

The native wrapper's optional `addDeviceDisconnectListener` is used when available. Its iOS `bluetooth_unauthorized`, `bluetooth_powered_off`, `connect_timeout`, and `session_init_failed` codes remain distinguishable in the library error model. `session_init_failed` allows authentication re-entry with a generic explanation; it does not assert that credentials were incorrect. Bluetooth permission failures do not open the device authentication screen. Android wrappers without per-device disconnect events still detect failure through command errors and bounded timeouts.
