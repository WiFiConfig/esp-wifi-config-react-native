/**
 * Zustand store — bridges the service layers into React.
 *
 * Notes:
 *   - No `polling` / live WiFi-state fields. The SDK's atomic provision()
 *     call is the only join mechanism, so the store carries no `wifiState`,
 *     `wifiSsid`, `wifiIp`, `wifiRssi`, `wifiQuality`, or `polling`.
 *   - No `addNetwork` / `delNetwork` / `connectWifi` / `disconnectWifi`
 *     / `getApStatus` / `startAp` / `stopAp` / `factoryReset` actions —
 *     those are not part of the BLE provisioning protocol (use the device's
 *     HTTP API for post-join management).
 *   - Custom protocomm endpoints surface as `getVersion`, `getCapabilities`,
 *     `getNetworkPolicy`, `getNetworkInfo`, `listVars`, `getVar`, `setVar`,
 *     `delVar` actions.
 */

import { create } from 'zustand';

import {
  destroyServices,
  getManager,
  getProtocol,
  getTransport,
  initializeServices,
} from '../serviceFactory';

import type {
  DeviceAuthCredentials,
  DeviceCapabilities,
  DeviceConnection,
  DeviceNetworkInfo,
  DeviceNetworkPolicy,
  DeviceVariable,
  DeviceVersionInfo,
  DiscoveredDevice,
  ProvisioningConfig,
  ProvisioningError,
  ProvisioningResult,
  ProvisioningStep,
  ProvisionResult,
  ScanCompletedInfo,
  ScannedNetwork,
  SecurityVersion,
} from '../types';

/**
 * Which inputs the `enterDeviceAuth` screen should render. Derived from
 * the resolved `security` version once services initialize.
 *
 *   - `null` — sec0; the screen is never shown.
 *   - `'pop'` — sec1; single Proof-of-Possession field.
 *   - `'srp'` — sec2; username + SRP-password fields.
 */
export type DeviceAuthMode = 'pop' | 'srp' | null;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ProvisioningStoreState {
  // -- Wizard --
  step: ProvisioningStep;
  error: ProvisioningError | null;
  /** Latest successful result. Survives `cancel()`; cleared on next `start()`. */
  lastResult: ProvisioningResult | null;
  /** Most recent SDK provision() result. Cleared when starting a new run. */
  lastProvisionResult: ProvisionResult | null;

  // -- Devices --
  discoveredDevices: DiscoveredDevice[];
  device: DeviceConnection;
  scanning: boolean;
  lastScanResult: ScanCompletedInfo | null;

  // -- WiFi --
  scannedNetworks: ScannedNetwork[];
  selectedNetwork: ScannedNetwork | null;

  // -- Auth --
  /** Which auth inputs the enterDeviceAuth screen should render. */
  authMode: DeviceAuthMode;
  /** Default values to seed the auth screen with (from config). */
  defaultAuthValues: DeviceAuthCredentials;
  /** Most recently submitted auth values (for pre-fill on unauthorized bounce). */
  pendingAuth: DeviceAuthCredentials | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ProvisioningStoreActions {
  // -- Lifecycle --
  initialize: (config?: ProvisioningConfig) => void;
  destroy: () => Promise<void>;

  // -- Wizard verbs --
  start: () => Promise<void>;
  chooseDevice: (target: DiscoveredDevice) => Promise<void>;
  proceedFromConfigure: () => Promise<void>;
  rescanWifi: () => Promise<void>;
  chooseNetwork: (network: ScannedNetwork) => void;
  backToNetworks: () => void;
  submitPassword: (password: string) => Promise<void>;
  retryJoin: (password?: string) => Promise<void>;
  pickDifferentNetwork: () => Promise<void>;
  pickDifferentDevice: () => Promise<void>;
  cancel: () => Promise<void>;
  submitDeviceAuth: (creds: DeviceAuthCredentials) => Promise<void>;

  // -- Direct protocol commands --
  scanWifi: () => Promise<ScannedNetwork[]>;
  getVersion: () => Promise<DeviceVersionInfo>;
  getCapabilities: () => Promise<DeviceCapabilities>;
  getNetworkPolicy: () => Promise<DeviceNetworkPolicy>;
  getNetworkInfo: () => Promise<DeviceNetworkInfo>;
  listVars: () => Promise<DeviceVariable[]>;
  getVar: (key: string) => Promise<DeviceVariable | null>;
  setVar: (key: string, value: string) => Promise<void>;
  delVar: (key: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

const initialState: ProvisioningStoreState = {
  step: 'welcome',
  error: null,
  lastResult: null,
  lastProvisionResult: null,

  discoveredDevices: [],
  device: null,
  scanning: false,
  lastScanResult: null,

  scannedNetworks: [],
  selectedNetwork: null,

  authMode: null,
  defaultAuthValues: {},
  pendingAuth: null,
};

function authModeForSecurity(security: SecurityVersion): DeviceAuthMode {
  if (security === 1) return 'pop';
  if (security === 2) return 'srp';
  return null;
}

// ---------------------------------------------------------------------------
// Subscription wiring
// ---------------------------------------------------------------------------

let unsubscribers: Array<() => void> = [];
let subscribedManager: object | null = null;

type SetState = (
  partial:
    | Partial<ProvisioningStoreState>
    | ((state: ProvisioningStoreState) => Partial<ProvisioningStoreState>),
) => void;

function subscribeToServices(set: SetState): void {
  const manager = getManager();
  if (subscribedManager === manager) return;

  for (const unsub of unsubscribers) unsub();
  unsubscribers = [];
  subscribedManager = manager;

  const transport = getTransport();

  // Transport
  unsubscribers.push(
    transport.on('connectionStateChanged', (state) => {
      set({ scanning: state === 'scanning' });
    }),
  );
  unsubscribers.push(
    transport.on('deviceDiscovered', (device) => {
      set((s) => ({
        discoveredDevices: [
          ...s.discoveredDevices.filter((d) => d.id !== device.id),
          device,
        ],
      }));
    }),
  );
  unsubscribers.push(
    transport.on('scanStopped', () => {
      set({ scanning: false });
    }),
  );
  unsubscribers.push(
    transport.on('scanCompleted', (info) => {
      set({ lastScanResult: info });
    }),
  );

  // Manager
  unsubscribers.push(
    manager.on('stepChanged', (step) => {
      set({ step });
    }),
  );
  unsubscribers.push(
    manager.on('errorChanged', (error) => {
      set({ error });
    }),
  );
  unsubscribers.push(
    manager.on('scannedNetworksUpdated', (networks) => {
      set({ scannedNetworks: networks });
    }),
  );
  unsubscribers.push(
    manager.on('selectedNetworkChanged', (network) => {
      set({ selectedNetwork: network });
    }),
  );
  unsubscribers.push(
    manager.on('deviceConnectionChanged', (device) => {
      set({ device });
    }),
  );
  unsubscribers.push(
    manager.on('provisioningComplete', (result) => {
      set({ lastResult: result });
    }),
  );
  unsubscribers.push(
    manager.on('provisioningResultUpdated', (result) => {
      set({ lastResult: result });
    }),
  );
  unsubscribers.push(
    manager.on('provisionResult', (result) => {
      set({ lastProvisionResult: result });
    }),
  );
  unsubscribers.push(
    manager.on('provisioningReset', () => {
      set((s) => ({
        ...initialState,
        lastResult: s.lastResult,
      }));
    }),
  );
}

function ensureInitialized(set: SetState, config?: ProvisioningConfig): void {
  initializeServices(config);
  subscribeToServices(set);
  // Push the resolved auth shape into the store so screens can decide
  // what to render without reaching into the transport themselves.
  const t = getTransport().resolvedConfig;
  set({
    authMode: authModeForSecurity(t.security),
    defaultAuthValues: {
      pop: t.proofOfPossession,
      username: t.username,
    },
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useProvisioningStore = create<
  ProvisioningStoreState & ProvisioningStoreActions
>()((set) => ({
  ...initialState,

  // Lifecycle
  initialize: (config) => {
    ensureInitialized(set, config);
  },

  destroy: async () => {
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
    subscribedManager = null;
    set(initialState);
    await destroyServices();
  },

  // Wizard verbs
  start: async () => {
    ensureInitialized(set);
    set({
      lastResult: null,
      lastProvisionResult: null,
      discoveredDevices: [],
    });
    await getManager().start();
  },

  chooseDevice: async (target) => {
    ensureInitialized(set);
    await getManager().chooseDevice(target);
  },

  proceedFromConfigure: async () => {
    ensureInitialized(set);
    await getManager().proceedFromConfigure();
  },

  rescanWifi: async () => {
    ensureInitialized(set);
    await getManager().rescanWifi();
  },

  chooseNetwork: (network) => {
    ensureInitialized(set);
    getManager().chooseNetwork(network);
  },

  backToNetworks: () => {
    ensureInitialized(set);
    getManager().backToNetworks();
  },

  submitPassword: async (password) => {
    ensureInitialized(set);
    await getManager().submitPassword(password);
  },

  retryJoin: async (password) => {
    ensureInitialized(set);
    await getManager().retryJoin(password);
  },

  pickDifferentNetwork: async () => {
    ensureInitialized(set);
    await getManager().pickDifferentNetwork();
  },

  pickDifferentDevice: async () => {
    ensureInitialized(set);
    set({ discoveredDevices: [] });
    await getManager().pickDifferentDevice();
  },

  cancel: async () => {
    ensureInitialized(set);
    await getManager().cancel();
    set({ pendingAuth: null });
  },

  submitDeviceAuth: async (creds) => {
    ensureInitialized(set);
    // Remember what the user typed so the screen can pre-fill on a
    // possible unauthorized bounce — manager exposes its pending values
    // too but the store-level snapshot avoids cross-layer coupling in
    // selectors.
    set({ pendingAuth: { ...creds } });
    await getManager().submitDeviceAuth(creds);
  },

  // Direct protocol commands
  scanWifi: async () => {
    ensureInitialized(set);
    return getProtocol().scanWifi();
  },
  getVersion: async () => {
    ensureInitialized(set);
    return getProtocol().getVersion();
  },
  getCapabilities: async () => {
    ensureInitialized(set);
    return getProtocol().getCapabilities();
  },
  getNetworkPolicy: async () => {
    ensureInitialized(set);
    return getProtocol().getNetworkPolicy();
  },
  getNetworkInfo: async () => {
    ensureInitialized(set);
    return getProtocol().getNetworkInfo();
  },
  listVars: async () => {
    ensureInitialized(set);
    return getProtocol().listVars();
  },
  getVar: async (key) => {
    ensureInitialized(set);
    return getProtocol().getVar(key);
  },
  setVar: async (key, value) => {
    ensureInitialized(set);
    return getProtocol().setVar(key, value);
  },
  delVar: async (key) => {
    ensureInitialized(set);
    return getProtocol().delVar(key);
  },
}));
