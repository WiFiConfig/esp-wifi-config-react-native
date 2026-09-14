/**
 * Focused tests for BleTransport's scan.
 *
 * The transport runs a SINGLE match-all BLE scan and filters results by the
 * configured prefixes in JS, rather than one scan per prefix. This pins that
 * behaviour and guards the bug it replaced: scanning per-prefix ran a full
 * ~5s BLE scan for each prefix, so a multi-prefix config (e.g.
 * `['BrewPiESP-', 'TiltBridge-']`) took ~10s and the hard-cap timeout
 * force-stopped a later prefix's scan into a false "no devices found".
 */

import { mockHooks } from '../__mocks__/esp-idf-provisioning';
import {
  ESPDevice,
  ESPProvisionManager,
  ESPSecurity,
  ESPTransport,
} from '../__mocks__/esp-idf-provisioning';
import { BleTransport } from '../services/BleTransport';
import { setLogLevel } from '../utils/logger';
import type {
  BleLibraryError,
  DiscoveredDevice,
  ScanCompletedInfo,
} from '../types/ble';

const device = (name: string) =>
  new ESPDevice({ name, transport: ESPTransport.ble, security: ESPSecurity.secure });

/** Run a scan and collect every event the transport emits. */
async function runScan(transport: BleTransport): Promise<{
  discovered: DiscoveredDevice[];
  errors: BleLibraryError[];
  completed: ScanCompletedInfo | null;
}> {
  const discovered: DiscoveredDevice[] = [];
  const errors: BleLibraryError[] = [];
  let completed: ScanCompletedInfo | null = null;

  transport.on('deviceDiscovered', (d) => discovered.push(d));
  transport.on('error', (e) => errors.push(e as BleLibraryError));
  transport.on('scanCompleted', (info) => {
    completed = info;
  });

  await transport.startScan();
  return { discovered, errors, completed };
}

describe('BleTransport scan', () => {
  beforeEach(() => {
    mockHooks.search = undefined;
    jest.restoreAllMocks();
    setLogLevel('warn');
  });

  afterEach(() => {
    setLogLevel('warn');
    jest.restoreAllMocks();
  });

  it('scans the air exactly once regardless of prefix count', async () => {
    const spy = jest.spyOn(ESPProvisionManager, 'searchESPDevices');
    mockHooks.search = () => [device('TiltBridge-E3F6B0')];

    const transport = new BleTransport({
      deviceNamePrefix: ['BrewPiESP-', 'TiltBridge-', 'PROV_'],
      scanTimeoutMs: 1000,
    });
    await runScan(transport);

    // One match-all scan (empty prefix), not one per configured prefix.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('');
  });

  it('surfaces a device that matches any configured prefix', async () => {
    // Only a TiltBridge is present, but BrewPiESP- is also configured. The
    // TiltBridge must still appear (the original multi-prefix failure).
    mockHooks.search = () => [device('TiltBridge-E3F6B0')];

    const transport = new BleTransport({
      deviceNamePrefix: ['BrewPiESP-', 'TiltBridge-'],
      scanTimeoutMs: 1000,
    });
    const { discovered, errors, completed } = await runScan(transport);

    expect(discovered.map((d) => d.name)).toEqual(['TiltBridge-E3F6B0']);
    expect(errors).toHaveLength(0);
    expect(completed?.matched).toBe(1);
  });

  it('filters out devices that match no configured prefix', async () => {
    mockHooks.search = () => [
      device('SomeHeadphones'),
      device('TiltBridge-E3F6B0'),
      device('BrewPiESP-AB12CD'),
    ];

    const transport = new BleTransport({
      deviceNamePrefix: ['BrewPiESP-', 'TiltBridge-'],
      scanTimeoutMs: 1000,
    });
    const { discovered } = await runScan(transport);

    expect(discovered.map((d) => d.name).sort()).toEqual([
      'BrewPiESP-AB12CD',
      'TiltBridge-E3F6B0',
    ]);
  });

  it('matches prefixes case-insensitively (mirrors the native SDK)', async () => {
    mockHooks.search = () => [device('tiltbridge-e3f6b0')];

    const transport = new BleTransport({
      deviceNamePrefix: ['TiltBridge-'],
      scanTimeoutMs: 1000,
    });
    const { discovered } = await runScan(transport);

    expect(discovered.map((d) => d.name)).toEqual(['tiltbridge-e3f6b0']);
  });

  it('reports "no devices" via scanCompleted (not error) when the scan finds nothing', async () => {
    // The SDK rejects a scan that finds no named device at all.
    mockHooks.search = () => {
      throw new Error('No bluetooth device found with given prefix.');
    };

    const transport = new BleTransport({
      deviceNamePrefix: ['BrewPiESP-', 'TiltBridge-'],
      scanTimeoutMs: 1000,
    });
    const { discovered, errors, completed } = await runScan(transport);

    expect(discovered).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(completed?.matched).toBe(0);
  });

  it('reports "no devices" when named devices exist but none match a prefix', async () => {
    mockHooks.search = () => [device('SomeHeadphones'), device('A-TV')];

    const transport = new BleTransport({
      deviceNamePrefix: ['TiltBridge-'],
      scanTimeoutMs: 1000,
    });
    const { discovered, errors, completed } = await runScan(transport);

    expect(discovered).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(completed?.matched).toBe(0);
  });

  it('surfaces an actionable failure (powered off) when the scan fails hard', async () => {
    mockHooks.search = () => {
      throw new Error('Bluetooth is powered off');
    };

    const transport = new BleTransport({
      deviceNamePrefix: ['TiltBridge-'],
      scanTimeoutMs: 1000,
    });
    const { errors } = await runScan(transport);

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('powered_off');
  });

  it('de-duplicates a device returned more than once', async () => {
    mockHooks.search = () => [
      device('TiltBridge-E3F6B0'),
      device('TiltBridge-E3F6B0'),
    ];

    const transport = new BleTransport({
      deviceNamePrefix: ['TiltBridge-'],
      scanTimeoutMs: 1000,
    });
    const { discovered, completed } = await runScan(transport);

    expect(discovered).toHaveLength(1);
    expect(completed?.matched).toBe(1);
  });

  it.each([
    ['bluetooth_powered_off', 'No bluetooth device found with given prefix.', 'powered_off'],
    ['bluetooth_unauthorized', 'No bluetooth device found with given prefix.', 'bluetooth_unauthorized'],
    ['scan_failed', 'Bluetooth is powered off; no bluetooth device found.', 'powered_off'],
    ['error', 'Bluetooth is disabled. No bluetooth device found.', 'powered_off'],
    ['scan_failed', 'Bluetooth permission denied; no bluetooth device found.', 'bluetooth_unauthorized'],
    ['error', 'Missing permissions: BLUETOOTH_SCAN. No bluetooth device found.', 'bluetooth_unauthorized'],
  ])('preserves actionable %s errors even when the SDK also reports no devices', async (code, message, expectedCode) => {
    mockHooks.search = () => { throw Object.assign(new Error(message), { code }); };
    const transport = new BleTransport();
    const { errors, completed } = await runScan(transport);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: expectedCode, message });
    expect(completed).toBeNull();
    expect(transport.connectionState).toBe('disconnected');
    await transport.destroy();
  });

  it.each(['error', 'scan_failed'])('keeps an ordinary no-device %s response benign', async (code) => {
    mockHooks.search = () => {
      throw Object.assign(new Error('No bluetooth device found with given prefix.'), { code });
    };
    const transport = new BleTransport();
    const { errors, completed } = await runScan(transport);
    expect(errors).toEqual([]);
    expect(completed?.matched).toBe(0);
    await transport.destroy();
  });

  it('logs the native result count without logging returned device details', async () => {
    setLogLevel('debug');
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    mockHooks.search = () => [device('PROV_private-device-name')];
    const transport = new BleTransport();
    await runScan(transport);
    expect(debug).toHaveBeenCalledWith(
      '[esp-wifi-mgr:BleTransport]', 'Native BLE scan result', { count: 1 },
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private-device-name');
    await transport.destroy();
  });

  it('logs only the native error code and message before benign-error classification', async () => {
    setLogLevel('debug');
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const message = 'No bluetooth device found with given prefix.';
    mockHooks.search = () => {
      throw Object.assign(new Error(message), { code: 'scan_failed', nativeExtra: 'do-not-log' });
    };
    const transport = new BleTransport();
    const { errors } = await runScan(transport);
    expect(errors).toEqual([]);
    expect(debug).toHaveBeenCalledWith(
      '[esp-wifi-mgr:BleTransport]', 'Native BLE scan rejected', { code: 'scan_failed', message },
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain('do-not-log');
    await transport.destroy();
  });
});
