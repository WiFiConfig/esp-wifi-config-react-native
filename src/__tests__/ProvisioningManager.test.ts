/**
 * High-level smoke tests for the ProvisioningManager step machine.
 *
 * These don't exhaustively cover every edge case — the bar here is that the
 * core path (scan → connect → wifi-scan → choose → submitPassword → success)
 * transitions cleanly, plus the auth-prompt and disconnect-safety branches.
 */

import { mockHooks } from '../__mocks__/esp-idf-provisioning';
import { BleTransport } from '../services/BleTransport';
import { DeviceProtocol } from '../services/DeviceProtocol';
import { ProvisioningManager } from '../services/ProvisioningManager';
import {
  ESPDevice,
  ESPSecurity,
  ESPTransport,
  ESPWifiAuthMode,
} from '../__mocks__/esp-idf-provisioning';

describe('ProvisioningManager (SDK-backed)', () => {
  beforeEach(() => {
    // Reset hook overrides between tests
    mockHooks.search = undefined;
    mockHooks.connect = undefined;
    mockHooks.scanWifi = undefined;
    mockHooks.provision = undefined;
    mockHooks.sendData = () => JSON.stringify({ connected: true });
  });

  it('walks happy-path: start → device → wifi → submit → success', async () => {
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'AB12CD', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => [
      { ssid: 'Home', rssi: -45, auth: ESPWifiAuthMode.wpa2Psk },
    ];
    mockHooks.provision = async () => ({ status: 'success' });

    const transport = new BleTransport({ deviceNamePrefix: 'PROV_', proofOfPossession: 'abcd1234' });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    const steps: string[] = [];
    manager.on('stepChanged', (s) => steps.push(s));

    await manager.start();
    // After scan completes the manager remains on `scanBle`; tests pick
    // a device explicitly.
    const devices = transport.connectionState; // 'disconnected' once scan resolved
    expect(devices).toBe('disconnected');

    await manager.chooseDevice({
      id: 'PROV_AB12CD',
      name: 'PROV_AB12CD',
      rssi: null,
    });

    expect(steps).toContain('connectingBle');
    expect(steps).toContain('configuring');
    expect(steps).toContain('scanningWifi');
    expect(steps).toContain('chooseNetwork');

    manager.chooseNetwork({ ssid: 'Home', rssi: -45, auth: 'WPA2' });
    expect(manager.currentStep).toBe('enterCredentials');

    await manager.submitPassword('hunter2');
    expect(manager.currentStep).toBe('success');
  });

  it('lands on chooseNetwork with a protocol error if scanWifi rejects', async () => {
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'AB12CD', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => {
      throw new Error('scan failed');
    };

    const transport = new BleTransport({ deviceNamePrefix: 'PROV_', proofOfPossession: 'abcd1234' });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    await manager.start();
    await manager.chooseDevice({
      id: 'PROV_AB12CD',
      name: 'PROV_AB12CD',
      rssi: null,
    });

    expect(manager.currentStep).toBe('chooseNetwork');
    expect(manager.error?.source).toBe('protocol');
  });

  it('parks on joiningWifi with provision-source error on provision failure', async () => {
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'AB12CD', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => [
      { ssid: 'Home', rssi: -45, auth: ESPWifiAuthMode.wpa2Psk },
    ];
    mockHooks.provision = async () => {
      throw new Error('STA connect failed');
    };

    const transport = new BleTransport({ deviceNamePrefix: 'PROV_', proofOfPossession: 'abcd1234' });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    await manager.start();
    await manager.chooseDevice({
      id: 'PROV_AB12CD',
      name: 'PROV_AB12CD',
      rssi: null,
    });
    manager.chooseNetwork({ ssid: 'Home', rssi: -45, auth: 'WPA2' });
    await manager.submitPassword('hunter2');

    expect(manager.currentStep).toBe('joiningWifi');
    expect(manager.error?.source).toBe('provision');
    expect(manager.error?.recoverable).toBe(true);
  });

  it('treats a BLE disconnect during joiningWifi as success, not a fatal error', async () => {
    // Regression: the esp_wifi_config firmware reboots on successful
    // provisioning and drops BLE as soon as the client disconnects after
    // seeing "connected" — which can race the resolution of the SDK's
    // atomic provision(). A disconnect observed on joiningWifi must NOT
    // fire connection_lost / cancel(): that would clobber a provision that
    // actually succeeded. (See DISCONNECT_SAFE_STEPS; spec §18.2.)
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'AB12CD', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => [
      { ssid: 'Home', rssi: -45, auth: ESPWifiAuthMode.wpa2Psk },
    ];
    // Deferred provision so we can inject a BLE disconnect while it is
    // still pending (mirroring the firmware rebooting mid-poll).
    let resolveProvision!: (r: { status: string }) => void;
    mockHooks.provision = () =>
      new Promise((resolve) => {
        resolveProvision = resolve;
      });

    const transport = new BleTransport({ deviceNamePrefix: 'PROV_', proofOfPossession: 'abcd1234' });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    await manager.start();
    await manager.chooseDevice({ id: 'PROV_AB12CD', name: 'PROV_AB12CD', rssi: null });
    manager.chooseNetwork({ ssid: 'Home', rssi: -45, auth: 'WPA2' });

    // Kick off provisioning but don't await — parked on joiningWifi with
    // provision() in flight.
    const provisioning = manager.submitPassword('hunter2');
    expect(manager.currentStep).toBe('joiningWifi');

    // Firmware reboots on success → BLE link drops mid-provision.
    // disconnect() is the public path that emits connectionStateChanged.
    await transport.disconnect();

    // Must NOT have cancelled the flow or raised an error.
    expect(manager.currentStep).toBe('joiningWifi');
    expect(manager.error).toBeNull();

    // provision() then resolves successfully (device is on WiFi).
    resolveProvision({ status: 'connected' });
    await provisioning;

    expect(manager.currentStep).toBe('success');
    expect(manager.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // enterDeviceAuth: skip / prompt / unauthorized-retry
  // -------------------------------------------------------------------------

  it('skips enterDeviceAuth when sec0 (no auth needed)', async () => {
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'X', transport: ESPTransport.ble, security: ESPSecurity.unsecure }),
    ];
    mockHooks.scanWifi = () => [];

    const transport = new BleTransport({ deviceNamePrefix: 'PROV_', security: 0 });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    const steps: string[] = [];
    manager.on('stepChanged', (s) => steps.push(s));

    await manager.start();
    await manager.chooseDevice({ id: 'PROV_X', name: 'PROV_X', rssi: null });

    expect(steps).not.toContain('enterDeviceAuth');
    expect(steps).toContain('connectingBle');
  });

  it('skips enterDeviceAuth when sec1 with configured pop and promptForAuth=false', async () => {
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'X', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => [];

    const transport = new BleTransport({
      deviceNamePrefix: 'PROV_',
      security: 1,
      proofOfPossession: 'abcd1234',
    });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    const steps: string[] = [];
    manager.on('stepChanged', (s) => steps.push(s));

    await manager.start();
    await manager.chooseDevice({ id: 'PROV_X', name: 'PROV_X', rssi: null });

    expect(steps).not.toContain('enterDeviceAuth');
  });

  it('routes to enterDeviceAuth when sec1 with promptForAuth=true', async () => {
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'X', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => [];

    const transport = new BleTransport({
      deviceNamePrefix: 'PROV_',
      security: 1,
      promptForAuth: true,
    });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    await manager.start();
    await manager.chooseDevice({ id: 'PROV_X', name: 'PROV_X', rssi: null });
    expect(manager.currentStep).toBe('enterDeviceAuth');

    await manager.submitDeviceAuth({ pop: 'mySecret' });
    // After submit we drive through connect → configuring → wifi scan → choose
    expect(['connectingBle', 'configuring', 'scanningWifi', 'chooseNetwork']).toContain(
      manager.currentStep,
    );
  });

  it('routes to enterDeviceAuth when sec2 with promptForAuth=true and validates required fields', async () => {
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'X', transport: ESPTransport.ble, security: ESPSecurity.secure2 }),
    ];
    mockHooks.scanWifi = () => [];

    const transport = new BleTransport({
      deviceNamePrefix: 'PROV_',
      security: 2,
      promptForAuth: true,
    });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    await manager.start();
    await manager.chooseDevice({ id: 'PROV_X', name: 'PROV_X', rssi: null });
    expect(manager.currentStep).toBe('enterDeviceAuth');

    // Missing pop → flow-source error, stays on the step.
    await manager.submitDeviceAuth({ username: 'admin' });
    expect(manager.currentStep).toBe('enterDeviceAuth');
    expect(manager.error?.source).toBe('flow');
    expect(manager.error?.code).toBe('missing_pop');

    // Supplying pop (username falls back to config default) advances.
    await manager.submitDeviceAuth({ pop: 'pw' });
    expect(['connectingBle', 'configuring', 'scanningWifi', 'chooseNetwork']).toContain(
      manager.currentStep,
    );
  });

  it('bounces back to enterDeviceAuth on unauthorized connect failure', async () => {
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'X', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => [];

    let attempts = 0;
    mockHooks.connect = () => {
      attempts++;
      if (attempts === 1) throw new Error('unauthorized: bad PoP');
      // Subsequent connect attempts succeed.
    };

    const transport = new BleTransport({
      deviceNamePrefix: 'PROV_',
      security: 1,
      promptForAuth: true,
    });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    await manager.start();
    await manager.chooseDevice({ id: 'PROV_X', name: 'PROV_X', rssi: null });
    expect(manager.currentStep).toBe('enterDeviceAuth');

    // First submit → connect throws unauthorized → bounce back.
    await manager.submitDeviceAuth({ pop: 'wrongpop' });
    expect(manager.currentStep).toBe('enterDeviceAuth');
    expect(manager.error?.source).toBe('ble');
    expect(manager.error?.code).toBe('unauthorized');
    // The previously submitted value is preserved so the screen can pre-fill.
    expect(manager.pendingAuth?.pop).toBe('wrongpop');

    // Second submit succeeds and we advance.
    await manager.submitDeviceAuth({ pop: 'rightpop' });
    expect(['connectingBle', 'configuring', 'scanningWifi', 'chooseNetwork']).toContain(
      manager.currentStep,
    );
  });

  // -------------------------------------------------------------------------
  // Custom protocomm endpoint encoding
  // -------------------------------------------------------------------------

  it('sends vars requests as plain JSON (ESPDevice.sendData owns base64 framing)', async () => {
    // Regression: DeviceProtocol must NOT base64-encode the request itself.
    // `ESPDevice.sendData()` already base64-encodes the request and decodes the
    // response internally (raw string in, raw string out — the mock mirrors
    // that). Encoding here too would double-encode and the device would receive
    // base64 text instead of JSON (firmware → "bad_json").
    let captured: { path: string; data: string } | null = null;
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'X', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.sendData = async (path, data) => {
      captured = { path, data };
      return JSON.stringify({ ok: true }); // raw JSON, as the device returns it
    };

    const transport = new BleTransport({ deviceNamePrefix: 'PROV_', proofOfPossession: 'abcd1234' });
    const protocol = new DeviceProtocol(transport);
    await transport.startScan();
    await transport.connect('PROV_X');

    await protocol.setVar('mdns_name', 'demo');

    expect(captured).not.toBeNull();
    expect(captured!.path).toBe('esp-wifi-config-vars');
    // The device receives raw JSON, parseable directly — no extra base64 layer.
    expect(JSON.parse(captured!.data)).toEqual({
      op: 'set',
      key: 'mdns_name',
      value: 'demo',
    });
  });

  it('reads esp-wifi-config-network-info after a successful provision and attaches it to the result', async () => {
    // Firmware 0.2.0+: right after CRED_SUCCESS the device keeps BLE up for
    // ~15 s so the client can fetch its assigned IP. The manager polls the
    // endpoint (best-effort) and surfaces the answer on
    // ProvisioningResult.networkInfo. First poll may land before GOT_IP, so
    // simulate one `{connected:false}` followed by a full answer.
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'NI', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => [{ ssid: 'Home', rssi: -45, auth: ESPWifiAuthMode.wpa2Psk }];
    mockHooks.provision = async () => ({ status: 'success' });
    const infoPaths: string[] = [];
    let calls = 0;
    mockHooks.sendData = async (path) => {
      infoPaths.push(path);
      calls++;
      if (calls === 1) return JSON.stringify({ connected: false });
      return JSON.stringify({
        connected: true,
        ssid: 'Home',
        ip: '192.168.5.115',
        gateway: '192.168.5.1',
        hostname: 'esp-3f99',
        rssi: -57,
      });
    };

    const transport = new BleTransport({ deviceNamePrefix: 'PROV_', proofOfPossession: 'abcd1234' });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    const completed: unknown[] = [];
    manager.on('provisioningComplete', (r) => completed.push(r));
    const enrichment = new Promise<unknown>((resolve) => manager.on('provisioningResultUpdated', resolve));

    await manager.start();
    await manager.chooseDevice({ id: 'PROV_NI', name: 'PROV_NI', rssi: null });
    manager.chooseNetwork({ ssid: 'Home', rssi: -45, auth: 'WPA2' });
    await manager.submitPassword('hunter2');

    expect(manager.currentStep).toBe('success');
    expect(infoPaths.every((p) => p === 'esp-wifi-config-network-info')).toBe(true);
    const enriched = await enrichment;
    expect(calls).toBe(2); // stopped polling as soon as connected:true arrived
    expect(completed).toHaveLength(1);
    expect(completed[0]).not.toHaveProperty('networkInfo');
    expect(enriched).toMatchObject({
      success: true,
      ssid: 'Home',
      provisionStatus: 'success',
      networkInfo: { connected: true, ip: '192.168.5.115', hostname: 'esp-3f99', rssi: -57 },
    });
  });

  it('still reaches success with networkInfo undefined when the network-info endpoint is unreachable', async () => {
    // Firmware 0.1.0 registered the endpoint without creating its GATT
    // characteristic, so every read fails. That must never turn a successful
    // provision into an error.
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'OLD', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => [{ ssid: 'Home', rssi: -45, auth: ESPWifiAuthMode.wpa2Psk }];
    mockHooks.provision = async () => ({ status: 'success' });
    mockHooks.sendData = async () => {
      throw new Error('characteristic not found');
    };

    const transport = new BleTransport({ deviceNamePrefix: 'PROV_', proofOfPossession: 'abcd1234' });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    const completed: Array<{ networkInfo?: unknown }> = [];
    manager.on('provisioningComplete', (r) => completed.push(r));

    await manager.start();
    await manager.chooseDevice({ id: 'PROV_OLD', name: 'PROV_OLD', rssi: null });
    manager.chooseNetwork({ ssid: 'Home', rssi: -45, auth: 'WPA2' });
    await manager.submitPassword('hunter2');

    expect(manager.currentStep).toBe('success');
    expect(manager.error).toBeNull();
    expect(completed).toHaveLength(1);
    expect(completed[0].networkInfo).toBeUndefined();
    await manager.cancel();
  });

  // -------------------------------------------------------------------------
  // PoP semantics: unset → prompt; '' → no-PoP Security 1; no implicit default
  // -------------------------------------------------------------------------

  it("connects a no-PoP Security 1 device without prompting when proofOfPossession is ''", async () => {
    // The firmware's own default is `prov_ble.pop = NULL` (no PoP). Both the
    // firmware and the native SDKs skip the PoP mixing step for an empty
    // value, so '' must reach the SDK as-is and must not trigger the auth
    // screen.
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'NOPOP', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => [];
    const seenPops: Array<string | null> = [];
    mockHooks.connect = (_name, pop) => {
      seenPops.push(pop);
    };

    const transport = new BleTransport({
      deviceNamePrefix: 'PROV_',
      security: 1,
      proofOfPossession: '',
    });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    const steps: string[] = [];
    manager.on('stepChanged', (s) => steps.push(s));

    await manager.start();
    await manager.chooseDevice({ id: 'PROV_NOPOP', name: 'PROV_NOPOP', rssi: null });

    expect(steps).not.toContain('enterDeviceAuth');
    expect(steps).toContain('connectingBle');
    expect(seenPops).toEqual(['']);
    expect(manager.error).toBeNull();
  });

  it('inserts enterDeviceAuth when sec1 and proofOfPossession is unset (no implicit default)', async () => {
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'X', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    mockHooks.scanWifi = () => [];
    let connectCalls = 0;
    mockHooks.connect = () => {
      connectCalls++;
    };

    const transport = new BleTransport({ deviceNamePrefix: 'PROV_', security: 1 });
    const protocol = new DeviceProtocol(transport);
    const manager = new ProvisioningManager(transport, protocol);

    await manager.start();
    await manager.chooseDevice({ id: 'PROV_X', name: 'PROV_X', rssi: null });

    expect(manager.currentStep).toBe('enterDeviceAuth');
    expect(connectCalls).toBe(0);
    // The auth screen seeds from config; nothing to pre-fill here.
    expect(transport.resolvedConfig.proofOfPossession).toBeUndefined();

    await manager.submitDeviceAuth({ pop: 'typed-by-user' });
    expect(connectCalls).toBe(1);
    expect(['connectingBle', 'configuring', 'scanningWifi', 'chooseNetwork']).toContain(
      manager.currentStep,
    );
  });

  it('headless connect() rejects with missing_credentials when sec1 and no PoP is configured or supplied', async () => {
    mockHooks.search = (prefix) => [
      new ESPDevice({ name: prefix + 'X', transport: ESPTransport.ble, security: ESPSecurity.secure }),
    ];
    let connectCalls = 0;
    mockHooks.connect = () => {
      connectCalls++;
    };

    const transport = new BleTransport({ deviceNamePrefix: 'PROV_', security: 1 });
    await transport.startScan();

    await expect(transport.connect('PROV_X')).rejects.toMatchObject({
      name: 'BleLibraryError',
      code: 'missing_credentials',
    });
    expect(connectCalls).toBe(0);
    expect(transport.connectionState).toBe('disconnected');
    expect(transport.isConnected).toBe(false);

    // Supplying the PoP per-call is enough; '' is a valid answer for sec1.
    await transport.connect('PROV_X', { pop: '' });
    expect(connectCalls).toBe(1);
    expect(transport.isConnected).toBe(true);
  });
});
