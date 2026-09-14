/**
 * Direct access to the device's custom protocomm endpoints. Useful for
 * headless / advanced paths that need to read version / capabilities /
 * variables outside the wizard flow.
 *
 * Each call is tracked: `loading` reflects whether ANY command from this
 * hook instance is in flight, and `error` holds the message of the most
 * recent failure. Both are scoped per-instance — they do NOT leak into
 * the wizard's `useProvisioning().error`.
 */

import { useCallback, useState } from 'react';

import { useProvisioningStore } from '../store/provisioningStore';
import { OperationCancelledError } from '../utils/operations';
import type {
  DeviceCapabilities,
  DeviceNetworkInfo,
  DeviceNetworkPolicy,
  DeviceVariable,
  DeviceVersionInfo,
  ScannedNetwork,
} from '../types';

/**
 * @example
 * const { getVersion, listVars, loading, error } = useDeviceProtocol();
 * const v = await getVersion();           // throws on failure
 * const vars = await listVars();
 */
export function useDeviceProtocol() {
  const scanWifiCmd = useProvisioningStore((s) => s.scanWifi);
  const getVersionCmd = useProvisioningStore((s) => s.getVersion);
  const getCapabilitiesCmd = useProvisioningStore((s) => s.getCapabilities);
  const getNetworkPolicyCmd = useProvisioningStore((s) => s.getNetworkPolicy);
  const getNetworkInfoCmd = useProvisioningStore((s) => s.getNetworkInfo);
  const listVarsCmd = useProvisioningStore((s) => s.listVars);
  const getVarCmd = useProvisioningStore((s) => s.getVar);
  const setVarCmd = useProvisioningStore((s) => s.setVar);
  const delVarCmd = useProvisioningStore((s) => s.delVar);

  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const track = useCallback(async <R>(promise: Promise<R>): Promise<R> => {
    setInFlight((c) => c + 1);
    setError(null);
    try {
      return await promise;
    } catch (err) {
      if (!(err instanceof OperationCancelledError)) {
        setError(err instanceof Error ? err.message : String(err));
      }
      throw err;
    } finally {
      setInFlight((c) => c - 1);
    }
  }, []);

  const scanWifi = useCallback(
    (): Promise<ScannedNetwork[]> => track(scanWifiCmd()),
    [track, scanWifiCmd],
  );
  const getVersion = useCallback(
    (): Promise<DeviceVersionInfo> => track(getVersionCmd()),
    [track, getVersionCmd],
  );
  const getCapabilities = useCallback(
    (): Promise<DeviceCapabilities> => track(getCapabilitiesCmd()),
    [track, getCapabilitiesCmd],
  );
  const getNetworkPolicy = useCallback(
    (): Promise<DeviceNetworkPolicy> => track(getNetworkPolicyCmd()),
    [track, getNetworkPolicyCmd],
  );
  const getNetworkInfo = useCallback(
    (): Promise<DeviceNetworkInfo> => track(getNetworkInfoCmd()),
    [track, getNetworkInfoCmd],
  );
  const listVars = useCallback(
    (): Promise<DeviceVariable[]> => track(listVarsCmd()),
    [track, listVarsCmd],
  );
  const getVar = useCallback(
    (key: string): Promise<DeviceVariable | null> => track(getVarCmd(key)),
    [track, getVarCmd],
  );
  const setVar = useCallback(
    (key: string, value: string): Promise<void> =>
      track(setVarCmd(key, value)),
    [track, setVarCmd],
  );
  const delVar = useCallback(
    (key: string): Promise<void> => track(delVarCmd(key)),
    [track, delVarCmd],
  );

  return {
    /** True while ANY command from this hook instance is in flight. */
    loading: inFlight > 0,
    /** Message of the most recent failed call from this hook, or null. */
    error,

    scanWifi,
    getVersion,
    getCapabilities,
    getNetworkPolicy,
    /**
     * One-shot read of the station's network details. Only meaningful once
     * the device is on Wi-Fi (i.e. after provision()); returns
     * `{ connected: false }` before that. Requires esp_wifi_config 0.2.0+.
     */
    getNetworkInfo,
    listVars,
    getVar,
    setVar,
    delVar,
  };
}
