import { BleTransport } from '../services/BleTransport';
import { DeviceProtocol } from '../services/DeviceProtocol';
import { ProvisioningManager } from '../services/ProvisioningManager';
import type { ProvisioningConfig, ProvisioningResult } from '../types';
import { ESPDevice, ESPTransport, ESPSecurity, emitMockDeviceDisconnect, mockHooks } from '../__mocks__/esp-idf-provisioning';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const target = { id: 'TiltBridge-test', name: 'TiltBridge-test', rssi: null };
const network = { ssid: 'Home', rssi: -40, auth: 'WPA2' as const };
const sdkDevice = (name: string) => new ESPDevice({ name, security: ESPSecurity.secure, transport: ESPTransport.ble });
const flush = () => jest.advanceTimersByTimeAsync(0);

describe('provisioning lifecycle boundaries', () => {
  const cleanup: Array<() => Promise<void>> = [];

  function setup(config?: ProvisioningConfig) {
    const transport = new BleTransport({ proofOfPossession: '', ...config?.ble });
    const protocol = new DeviceProtocol(transport, config?.protocol);
    const manager = new ProvisioningManager(transport, protocol, config);
    cleanup.push(async () => {
      await manager.destroy();
      protocol.destroy();
      await transport.destroy();
    });
    return { transport, protocol, manager };
  }

  async function select(manager: ProvisioningManager) {
    await manager.start();
    const choosing = manager.chooseDevice(target);
    await jest.advanceTimersByTimeAsync(500);
    return choosing;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    for (const key of Object.keys(mockHooks)) delete mockHooks[key as keyof typeof mockHooks];
    mockHooks.search = () => [sdkDevice(target.name)];
    mockHooks.scanWifi = () => [];
    mockHooks.sendData = () => JSON.stringify({ connected: true, ip: '192.168.1.10' });
  });

  afterEach(async () => {
    for (const destroy of cleanup.splice(0)) await destroy();
    await flush();
    jest.useRealTimers();
  });

  it('cancels a pending native connection promptly and ignores its late success', async () => {
    const pending = deferred<void>();
    const disconnect = jest.fn();
    mockHooks.connect = () => pending.promise;
    mockHooks.disconnect = disconnect;
    const { manager, transport } = setup();
    await manager.start();
    const choosing = manager.chooseDevice(target);
    await jest.advanceTimersByTimeAsync(500);
    expect(manager.currentStep).toBe('connectingBle');
    await manager.cancel();
    await choosing;
    expect(disconnect).toHaveBeenCalledWith(target.name);
    pending.resolve();
    await flush();
    expect(manager.currentStep).toBe('welcome');
    expect(transport.isConnected).toBe(false);
    expect(manager.device).toBeNull();
  });

  it('aborts custom configuration and prevents late callbacks from scanning Wi-Fi', async () => {
    const pending = deferred<void>();
    const scan = jest.fn(() => []);
    mockHooks.scanWifi = scan;
    let callbackSignal: AbortSignal | undefined;
    const { manager } = setup({ flow: { onConnected: async ({ signal }) => {
      callbackSignal = signal;
      await pending.promise;
    } } });
    await manager.start();
    const choosing = manager.chooseDevice(target);
    await jest.advanceTimersByTimeAsync(500);
    expect(manager.currentStep).toBe('configuring');
    await manager.cancel();
    await choosing;
    expect(callbackSignal?.aborted).toBe(true);
    pending.resolve();
    await flush();
    expect(scan).not.toHaveBeenCalled();
    expect(manager.currentStep).toBe('welcome');
  });

  it('ignores a cancelled Wi-Fi scan and does not restore its network list', async () => {
    const pending = deferred<[]>();
    mockHooks.scanWifi = () => pending.promise;
    const { manager } = setup();
    await manager.start();
    const choosing = manager.chooseDevice(target);
    await jest.advanceTimersByTimeAsync(500);
    expect(manager.currentStep).toBe('scanningWifi');
    await manager.cancel();
    await choosing;
    pending.resolve([]);
    await flush();
    expect(manager.currentStep).toBe('welcome');
    expect(manager.scannedNetworks).toEqual([]);
  });

  it('ignores provisioning success after cancel', async () => {
    const pending = deferred<{ status: string }>();
    mockHooks.provision = () => pending.promise;
    const { manager } = setup();
    const complete = jest.fn();
    manager.on('provisioningComplete', complete);
    await select(manager);
    manager.chooseNetwork(network);
    const joining = manager.submitPassword('test-password');
    await manager.cancel();
    await joining;
    pending.resolve({ status: 'success' });
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(manager.currentStep).toBe('welcome');
  });

  it('blocks duplicate device taps and duplicate credential submissions', async () => {
    const connecting = deferred<void>();
    const connect = jest.fn(() => connecting.promise);
    mockHooks.connect = connect;
    const { manager } = setup();
    await manager.start();
    const first = manager.chooseDevice(target);
    await manager.chooseDevice(target);
    await jest.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(1);
    connecting.resolve();
    await first;
    const pending = deferred<{ status: string }>();
    const provision = jest.fn(() => pending.promise);
    mockHooks.provision = provision;
    manager.chooseNetwork(network);
    const joining = manager.submitPassword('first');
    await manager.submitPassword('second');
    expect(provision).toHaveBeenCalledTimes(1);
    await manager.cancel();
    await joining;
    pending.reject(new Error('late native disconnect'));
    await flush();
  });

  it('publishes complete identity before success, then enriches without completing twice', async () => {
    const details = deferred<string>();
    mockHooks.sendData = () => details.promise;
    const { manager } = setup();
    const completed: ProvisioningResult[] = [];
    const enriched: ProvisioningResult[] = [];
    manager.on('provisioningComplete', (result) => completed.push(result));
    manager.on('provisioningResultUpdated', (result) => enriched.push(result));
    manager.on('stepChanged', (step) => {
      if (step === 'success') expect(completed).toHaveLength(1);
    });
    await select(manager);
    manager.chooseNetwork(network);
    await manager.submitPassword('test-password');
    expect(completed[0]).toMatchObject({ success: true, ssid: 'Home', deviceId: target.id, deviceName: target.name });
    expect(completed[0].networkInfo).toBeUndefined();
    details.resolve(JSON.stringify({ connected: true, ip: '192.168.1.10' }));
    await flush();
    expect(enriched[0].networkInfo?.ip).toBe('192.168.1.10');
    expect(completed).toHaveLength(1);
  });

  it('stops optional enrichment at one total deadline and ignores details after dismissal', async () => {
    const details = deferred<string>();
    const send = jest.fn(() => details.promise);
    mockHooks.sendData = send;
    const { manager } = setup({ flow: { networkInfoTimeoutMs: 100 } });
    const updated = jest.fn();
    manager.on('provisioningResultUpdated', updated);
    await select(manager);
    manager.chooseNetwork(network);
    await manager.submitPassword('test-password');
    await jest.advanceTimersByTimeAsync(100);
    expect(manager.currentStep).toBe('success');
    expect(send).toHaveBeenCalledTimes(1);
    await manager.cancel();
    details.resolve(JSON.stringify({ connected: true, ip: 'old-address' }));
    await flush();
    expect(updated).not.toHaveBeenCalled();
  });

  it('preserves a visible recovery reason when the native device disconnects', async () => {
    const { manager, transport } = setup();
    await select(manager);
    emitMockDeviceDisconnect(target.name);
    await flush();
    expect(transport.isConnected).toBe(false);
    expect(manager.currentStep).toBe('welcome');
    expect(manager.error).toMatchObject({ code: 'connection_lost', recoverable: false });
  });

  it('does not overlap optional reads after an endpoint timeout shorter than the total budget', async () => {
    const send = jest.fn(() => new Promise<string>(() => {}));
    mockHooks.sendData = send;
    const { manager } = setup({
      protocol: { defaultTimeoutMs: 100 },
      flow: { networkInfoTimeoutMs: 1000 },
    });
    await select(manager);
    manager.chooseNetwork(network);
    await manager.submitPassword('test-password');
    await jest.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(manager.currentStep).toBe('success');
    expect(manager.error).toBeNull();
  });

  it('does not label generic session setup errors as invalid credentials', async () => {
    mockHooks.connect = () => { throw Object.assign(new Error('Failed to initialise session with the device'), { code: 'session_init_failed' }); };
    const { manager } = setup({ ble: { proofOfPossession: 'configured-code' } });
    await select(manager);
    expect(manager.currentStep).toBe('enterDeviceAuth');
    expect(manager.error?.code).toBe('session_init_failed');
    expect(manager.error?.message).toContain('could not be established');
  });

  it.each([0, 1] as const)('does not demand credentials after session failure for security %s without a PoP', async (security) => {
    mockHooks.connect = () => { throw Object.assign(new Error('Session setup failed'), { code: 'session_init_failed' }); };
    const { manager } = setup({ ble: { security, proofOfPossession: '' } });
    await select(manager);
    expect(manager.currentStep).toBe('scanBle');
    expect(manager.error?.code).toBe('session_init_failed');
  });

  it('settles cancelled and timed-out scans even if native never calls back', async () => {
    const pending = deferred<ESPDevice[]>();
    mockHooks.search = () => pending.promise;
    const { transport } = setup({ ble: { scanTimeoutMs: 100 } });
    const discovered = jest.fn();
    transport.on('deviceDiscovered', discovered);
    const first = transport.startScan();
    transport.stopScan();
    await first;
    mockHooks.search = () => [sdkDevice('PROV_new')];
    await transport.startScan();
    pending.resolve([sdkDevice('PROV_old')]);
    await flush();
    expect(discovered.mock.calls.map(([device]) => device.name)).toEqual(['PROV_new']);
    mockHooks.search = () => new Promise(() => {});
    const errors = jest.fn();
    transport.on('error', errors);
    const timedOut = transport.startScan();
    await jest.advanceTimersByTimeAsync(100);
    await timedOut;
    expect(errors).toHaveBeenCalledTimes(1);
    expect(transport.connectionState).toBe('disconnected');
  });

  it('bounds discovery plus connection and cleans up the pending native handle', async () => {
    const pending = deferred<void>();
    mockHooks.connect = () => pending.promise;
    const disconnected = jest.fn();
    mockHooks.disconnect = disconnected;
    const { transport } = setup({ ble: { connectTimeoutMs: 100 } });
    const connecting = transport.connect(target.id);
    const rejected = expect(connecting).rejects.toMatchObject({ code: 'connect_timeout' });
    await jest.advanceTimersByTimeAsync(100);
    await rejected;
    expect(disconnected).toHaveBeenCalledWith(target.name);
    expect(transport.connectionState).toBe('disconnected');
    pending.resolve();
    await flush();
    expect(transport.isConnected).toBe(false);
  });

  it('isolates cancelled protocol requests from the next request and suppresses stale endpoint errors', async () => {
    const oldResponse = deferred<string>();
    mockHooks.sendData = () => oldResponse.promise;
    const { transport, protocol } = setup();
    await transport.connect(target.id);
    const errors = jest.fn();
    protocol.on('endpointError', errors);
    const oldRead = protocol.getVar('mdns_name');
    const rejected = expect(oldRead).rejects.toMatchObject({ code: 'operation_cancelled' });
    protocol.cancelPendingOperations();
    await rejected;
    mockHooks.sendData = () => JSON.stringify({ key: 'mdns_name', value: 'current-name' });
    expect(await protocol.getVar('mdns_name')).toEqual({ key: 'mdns_name', value: 'current-name' });
    oldResponse.reject(new Error('old native failure'));
    await flush();
    expect(errors).not.toHaveBeenCalled();
  });

  it('disconnects a timed-out provision so Retry cannot overlap the old native request', async () => {
    mockHooks.provision = () => new Promise(() => {});
    const { manager, transport } = setup({ flow: { provisionTimeoutMs: 100 } });
    await select(manager);
    manager.chooseNetwork(network);
    const joining = manager.submitPassword('test-password');
    await jest.advanceTimersByTimeAsync(100);
    await joining;
    expect(transport.isConnected).toBe(false);
    expect(manager.error?.recoverable).toBe(false);
    const retry = manager.retryJoin();
    await jest.advanceTimersByTimeAsync(500);
    await retry;
    expect(manager.currentStep).toBe('scanBle');
  });
});
