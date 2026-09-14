/**
 * Service Factory — creates and wires singleton service instances.
 *
 * Lazy initialization: services are created on first access. Three
 * services in dependency order:
 *
 *   BleTransport -> DeviceProtocol -> ProvisioningManager
 */

import { BleTransport } from './services/BleTransport';
import { DeviceProtocol } from './services/DeviceProtocol';
import { ProvisioningManager } from './services/ProvisioningManager';
import type { ProvisioningConfig } from './types';

let transport: BleTransport | null = null;
let protocol: DeviceProtocol | null = null;
let manager: ProvisioningManager | null = null;

let storedConfig: ProvisioningConfig | undefined;

function initializeServices(config?: ProvisioningConfig): void {
  if (transport) return;

  if (config !== undefined) {
    storedConfig = config;
  }

  transport = new BleTransport(storedConfig?.ble);
  protocol = new DeviceProtocol(transport, storedConfig?.protocol);
  manager = new ProvisioningManager(transport, protocol, storedConfig);
}

export function getTransport(): BleTransport {
  if (!transport) initializeServices(storedConfig);
  return transport!;
}

export function getProtocol(): DeviceProtocol {
  if (!protocol) initializeServices(storedConfig);
  return protocol!;
}

export function getManager(): ProvisioningManager {
  if (!manager) initializeServices(storedConfig);
  return manager!;
}

export async function destroyServices(): Promise<void> {
  const prevManager = manager;
  const prevProtocol = protocol;
  const prevTransport = transport;

  manager = null;
  protocol = null;
  transport = null;

  // Invalidate every old layer synchronously before yielding. React may mount
  // another wizard while cleanup settles; old native cleanup must not stop
  // that newly initialized session.
  const managerCleanup = prevManager?.destroy();
  prevProtocol?.destroy();
  const transportCleanup = prevTransport?.destroy();
  await Promise.all([managerCleanup, transportCleanup]);
}

export { initializeServices };
