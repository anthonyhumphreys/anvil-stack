import {
  MESH_MACHINE_CAPABILITIES,
  MESH_MACHINE_PROTOCOL_VERSION,
  type MeshMachineHostStatus,
} from '../../../cloud/contract/machine';

let hostStatus: MeshMachineHostStatus = {
  enabled: false,
  running: false,
  state: 'disabled',
  machineId: '',
  endpointGeneration: null,
  protocolVersion: MESH_MACHINE_PROTOCOL_VERSION,
  capabilities: [...MESH_MACHINE_CAPABILITIES],
  activeSessions: 0,
  managedOrigin: null,
};

export function getMeshMachineHostStatus(): MeshMachineHostStatus {
  return { ...hostStatus, capabilities: [...hostStatus.capabilities] };
}

export function setMeshMachineHostStatus(status: MeshMachineHostStatus): void {
  hostStatus = { ...status, capabilities: [...status.capabilities] };
}
