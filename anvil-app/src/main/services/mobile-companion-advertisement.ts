import type { MeshMachineAdvertisedEndpoint } from '../../../cloud/contract/machine';
import type { CompanionEndpoint, DeviceAdvertiseParams } from '../../../cloud/contract/companion';

const COMPANION_CAPABILITIES: DeviceAdvertiseParams['capabilities'] = ['observe', 'approve', 'steer'];

/** Keep host-local discovery available while the legacy REST surface is disabled. */
export function buildCompanionAdvertisementPayload(input: {
  companionEnabled: boolean;
  machine?: MeshMachineAdvertisedEndpoint;
  endpoints: CompanionEndpoint[];
}): Pick<DeviceAdvertiseParams, 'endpoints' | 'capabilities' | 'machine'> {
  const machineHostActive = input.machine !== undefined;
  return {
    endpoints: input.companionEnabled || machineHostActive ? input.endpoints : [],
    capabilities: input.companionEnabled ? [...COMPANION_CAPABILITIES] : [],
    ...(input.machine === undefined ? {} : { machine: input.machine }),
  };
}
