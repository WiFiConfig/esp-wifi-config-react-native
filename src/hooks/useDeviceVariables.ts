/**
 * Convenience hook for reading and writing device variables (key/value
 * application config exposed by the firmware via the
 * `esp-wifi-config-vars` custom protocomm endpoint).
 *
 * Returns null/false on error rather than throwing — easier to use from
 * effects without try/catch. The most recent error message is exposed via
 * `error`. `loading` reflects whether ANY call from this hook instance is
 * in flight (per-instance counter, NOT a global busy flag).
 */

import { useCallback, useState } from 'react';

import { useProvisioningStore } from '../store/provisioningStore';
import { OperationCancelledError } from '../utils/operations';
import type { DeviceVariable } from '../types';

/**
 * @example
 * const { getVariable, setVariable, listVariables, loading, error } = useDeviceVariables();
 * const v = await getVariable('mdns_name');
 * await setVariable('mdns_name', 'my-device');
 */
export function useDeviceVariables() {
  const listVarsCmd = useProvisioningStore((s) => s.listVars);
  const getVarCmd = useProvisioningStore((s) => s.getVar);
  const setVarCmd = useProvisioningStore((s) => s.setVar);
  const delVarCmd = useProvisioningStore((s) => s.delVar);

  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const listVariables = useCallback(async (): Promise<
    DeviceVariable[] | null
  > => {
    setInFlight((c) => c + 1);
    setError(null);
    try {
      return await listVarsCmd();
    } catch (err) {
      if (!(err instanceof OperationCancelledError)) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return null;
    } finally {
      setInFlight((c) => c - 1);
    }
  }, [listVarsCmd]);

  const getVariable = useCallback(
    async (key: string): Promise<DeviceVariable | null> => {
      setInFlight((c) => c + 1);
      setError(null);
      try {
        return await getVarCmd(key);
      } catch (err) {
        if (!(err instanceof OperationCancelledError)) {
          setError(err instanceof Error ? err.message : String(err));
        }
        return null;
      } finally {
        setInFlight((c) => c - 1);
      }
    },
    [getVarCmd],
  );

  const setVariable = useCallback(
    async (key: string, value: string): Promise<boolean> => {
      setInFlight((c) => c + 1);
      setError(null);
      try {
        await setVarCmd(key, value);
        return true;
      } catch (err) {
        if (!(err instanceof OperationCancelledError)) {
          setError(err instanceof Error ? err.message : String(err));
        }
        return false;
      } finally {
        setInFlight((c) => c - 1);
      }
    },
    [setVarCmd],
  );

  const deleteVariable = useCallback(
    async (key: string): Promise<boolean> => {
      setInFlight((c) => c + 1);
      setError(null);
      try {
        await delVarCmd(key);
        return true;
      } catch (err) {
        if (!(err instanceof OperationCancelledError)) {
          setError(err instanceof Error ? err.message : String(err));
        }
        return false;
      } finally {
        setInFlight((c) => c - 1);
      }
    },
    [delVarCmd],
  );

  return {
    loading: inFlight > 0,
    error,

    listVariables,
    getVariable,
    setVariable,
    deleteVariable,
  };
}
