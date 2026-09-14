# Changelog

## Unreleased — first integration lifecycle fixes

- Cancel pending scans, connections, protocol requests, custom configuration gates and result enrichment without allowing old completions to revive the wizard.
- Bound connection discovery/handshake (`ble.connectTimeoutMs`, 20 s default). Disconnect stalled protocol sessions before retry.
- Publish confirmed provisioning success immediately with stable device identity; enrich optional IP details through `provisioningResultUpdated` under one total deadline (`flow.networkInfoTimeoutMs`, 3 s default).
- Expose `onConnected` cancellation through `AbortSignal` and make store teardown awaitable.
- Consume native iOS disconnect events and structured errors when available. Keep connection-loss messages visible; distinguish session setup failure from incorrect credentials and OS permission denial.
- Add deferred-operation regressions for cancellation, restart, duplicate input, deadline cleanup and completion ordering.


## 1.0.0 — unreleased

Initial release. React Native library for provisioning Wi-Fi credentials onto an ESP32 over BLE
using ESP-IDF's official Network/Wi-Fi Provisioning protocol, via the
[`@orbital-systems/react-native-esp-idf-provisioning`](https://www.npmjs.com/package/@orbital-systems/react-native-esp-idf-provisioning)
native SDK. Targets [`esp_wifi_config`](https://github.com/WiFiConfig/esp_wifi_config) 0.2.0+ firmware
(0.2.3 recommended) with `CONFIG_WIFI_CFG_ENABLE_NETWORK_PROVISIONING=y`. See `MIGRATION.md` for
the firmware-version alignment notes.

### Architecture

- Four layers, each depending only on the one below: `BleTransport` (wraps the native SDK's
  `searchESPDevices`/`connect`/`disconnect`) → `DeviceProtocol` (`provision()` + `scanWifiList()`
  plus JSON-over-base64 for the firmware's custom protocomm endpoints) → `ProvisioningManager`
  (wizard step machine, unified error model, `onConnected` hook) → Zustand store → React hooks →
  pre-built screens. The SDK's atomic `provision()` resolves on STA-connect success or rejects on
  failure, so there is no separate connection poller.

### Step machine

- Ten distinct steps — every visible UI state is its own step, so consumers never derive shadow
  phase enums:
  `welcome → scanBle → [enterDeviceAuth] → connectingBle → configuring → scanningWifi →
  chooseNetwork → enterCredentials → joiningWifi → success`.
- `enterDeviceAuth` is inserted when the device needs runtime credentials (sec1 PoP, or sec2
  username + SRP password) — driven by `ble.promptForAuth`, missing pre-configured credentials, or
  an `unauthorized` retry.
- `STEP_NUMBERS` collapses sub-states into stable numbered progress dots.

### Action verbs (`useProvisioning()` / `ProvisioningManager`)

`start`, `chooseDevice`, `submitDeviceAuth`, `proceedFromConfigure`, `chooseNetwork`,
`backToNetworks`, `submitPassword`, `retryJoin`, `pickDifferentNetwork`, `pickDifferentDevice`,
`cancel`, `rescanWifi`.

### Unified error model

One field, four sources:

```ts
type ProvisioningError = {
  source: 'ble' | 'protocol' | 'provision' | 'flow';
  code?: string;        // e.g. 'unauthorized', 'provision_failed'
  message: string;
  recoverable: boolean;
};
```

### Unified device model

```ts
type DeviceConnection =
  | null
  | { status: 'connecting'; id; name; rssi: number | null }
  | { status: 'connected'; id; name; mtu: number | null };
```

### Security

- Security 0/1/2 supported. Default Security 1 (X25519 + AES-CTR + PoP) with no implicit PoP:
  set `ble.proofOfPossession` to the firmware's value (`examples/with_ble` uses `"abcd1234"`,
  exported as `DEFAULT_POP`), leave it unset to prompt the user, or pass `''` for a device that
  runs without a PoP. Security 2 (SRP6a + AES-GCM) additionally requires a pre-computed salt +
  verifier compiled into the firmware. Production fleets should use a unique PoP per device.

### Custom firmware endpoints (`DeviceProtocol`)

- `scanWifi()`, `provision()`, `getVersion()`, `getCapabilities()`, `getNetworkPolicy()`,
  `getNetworkInfo()` / `waitForNetworkInfo()`, `listVars()`, `getVar()`, `setVar()`, `delVar()`.
  These only work while the BLE protocomm session is alive — schedule them inside
  `flow.onConnected` or before `submitPassword()`; `waitForNetworkInfo()` is the exception, meant
  for the ~15 s window *after* `provision()` resolves. Post-provisioning device management is via
  the device's HTTP API once it is on the network.
- **Device IP over BLE.** After a successful `provision()` the manager polls
  `esp-wifi-config-network-info` (3 × 1 s, best-effort, never fails the flow) and stores the
  station's IP / gateway / RSSI / hostname on `ProvisioningResult.networkInfo`. The pre-built
  `SuccessScreen` shows IP, hostname and signal when present. Requires firmware 0.2.0+ — on 0.1.0
  the endpoint was registered but its GATT characteristic never created, so the read fails and
  `networkInfo` stays `undefined`.

### Firmware alignment — esp_wifi_config 0.2.3 (2026-09-03)

Audit of the library against the firmware at 0.2.3 (see `MIGRATION.md` for the full comparison).
The five-endpoint wire contract is unchanged since 0.1.0; the changes below are corrections, not
protocol changes.

- Minimum supported firmware is now **0.2.0** (documentation, package description). 0.1.0 still
  provisions but cannot serve `esp-wifi-config-network-info`.
- Documentation said "four custom endpoints" in several places; there are five. Fixed everywhere,
  including the firmware-behaviour notes in the guides.
- Source and docs referenced Kconfig options that do not exist
  (`CONFIG_WIFI_CFG_NETWORK_PROVISIONING_{SERVICE_PREFIX,POP,SECURITY2_USERNAME,SECURITY_*}`). On
  the firmware side everything except the two enable flags is a runtime field of
  `wifi_cfg_prov_config_t`. Comments now say so, and state that `DEFAULT_POP = 'abcd1234'` and
  `DEFAULT_SECURITY2_USERNAME = 'wificfg'` mirror the firmware repo's `examples/with_ble` — the
  firmware's own defaults are *no PoP* and *no username*.
- `useDeviceProtocol()` and the store gained `getNetworkInfo()` (it was reachable only via
  `DeviceProtocol` directly).
- **`ble.proofOfPossession` has no implicit default any more.** It used to fall back to
  `'abcd1234'`, which made the documented "prompt when credentials aren't pre-configured" rule
  unreachable and made an empty string indistinguishable from "unset" — so a Security 1 device
  with no PoP (the firmware's own default) could not be provisioned. Now: unset → the wizard
  inserts `enterDeviceAuth`, and a headless `BleTransport.connect()` throws the new
  `BleLibraryError` code `missing_credentials`; `''` → no-PoP Security 1, connects without
  prompting. `DEFAULT_POP` is still exported for apps that want the `examples/with_ble` value by
  name; the example app passes it explicitly.
- New exported types `DeviceCapability` and `DeviceProvisioningMode` narrow
  `DeviceCapabilities.capabilities` and `DeviceNetworkPolicy.provisioning_mode` to the values the
  firmware actually emits (still accepting unknown strings for forward compatibility).
  `DeviceVersionInfo.lib` is documented as unreliable: firmware 0.1.0–0.2.3 hardcodes it to
  `"esp_wifi_config 0.1.0"`.
- Removed the dead `DEFAULT_SDK_TIMEOUT_MS` export; nothing applied it.
- `GUIDES/06` now covers the 0.2.2 chunked REST responses and the 0.2.3
  `CONFIG_WIFI_CFG_ENABLE_SOFTAP=n` builds that ship no HTTP API at all.
- `npm run typecheck` passes again: the root `tsconfig.json` now excludes `example_app/` and
  `harness/` (their own dependency trees were being type-checked with the library's).
- `npm run lint` works again. There was no ESLint config and no TypeScript parser installed. Now
  ESLint 10 with a flat config (`eslint.config.mjs`), `typescript-eslint` recommended rules, the
  `react-hooks` rules-of-hooks / exhaustive-deps rules, and `consistent-type-imports` so the
  Babel build never emits a runtime import for a type. The one finding it produced —
  `DeviceProtocol` rethrowing a JSON-parse failure without `cause` — is fixed.

### Hooks

`useProvisioning`, `useDeviceScanner`, `useBleConnection`, `useDeviceProtocol`,
`useDeviceVariables`. `useDeviceProtocol`/`useDeviceVariables` track loading per-instance (no global
busy flag).

### Other

- `config.flow.onConnected` runs after BLE connect, before the Wi-Fi scan, for pre-provisioning
  setup (hostname, app variables, firmware checks). Throwing parks the manager on `configuring` with
  a recoverable `flow`-source error.
- `lastResult` survives `cancel()` so the success screen stays rendered after the device drops BLE.
- Multi-prefix scanning: `deviceNamePrefix` accepts `string | string[]`.
- `requestBluetoothPermissions()` helper for Android 12+/<12 and iOS.
- `BleTransport` emits `scanCompleted` after every scan; the `error` event is reserved for true
  failures (BLE off, unauthorized, scan error) — an empty scan is not an error.

### Notable fixes during development

- **`joiningWifi` is disconnect-safe** — the firmware reboots on a successful provision and drops
  BLE as soon as the client disconnects after seeing "connected", which can race the resolution of
  the SDK's atomic `provision()`. A BLE disconnect on `joiningWifi` is treated as success, not a
  fatal `connection_lost`; the real outcome comes from the `provision()` promise. Verified
  end-to-end on iOS hardware across Security 0/1/2. (Pairs with the firmware raising its
  reboot-on-success backstop 3 s → 15 s; see `bluetooth_spec.md` §18.2.)
- **Custom protocomm endpoints send `{}` for empty requests** — a zero-length write is not
  dispatched by the ESP32 protocomm BLE transport, so `getVersion`/`getCapabilities`/
  `getNetworkPolicy` would otherwise get no response. See `bluetooth_spec.md` §12 and §18.5.
