import { describe, expect, it } from 'vitest';
import type { MeshMachineAdvertisedEndpoint } from '../../../../cloud/contract/machine';
import type { CompanionEndpoint } from '../../../../cloud/contract/companion';
import { buildCompanionAdvertisementPayload } from '../mobile-companion-advertisement.js';

const endpoint: CompanionEndpoint = { kind: 'lan', host: '192.0.2.10', port: 47631 };
const machine: MeshMachineAdvertisedEndpoint = {
  hostEnrollmentId: 'host-enrollment',
  machineId: 'host-machine',
  endpointGeneration: 'host-generation',
  protocolVersion: 1,
  capabilities: ['machine.session/1', 'machine.stream/1'],
  operations: ['read.snapshot'],
};

describe('mobile companion machine advertisement', () => {
  it('keeps private discovery endpoints for Mesh when legacy REST is disabled', () => {
    expect(
      buildCompanionAdvertisementPayload({
        companionEnabled: false,
        machine,
        endpoints: [endpoint],
      }),
    ).toEqual({ endpoints: [endpoint], capabilities: [], machine });
  });

  it('keeps endpoint advertisement off when both Mesh and legacy companion are disabled', () => {
    expect(
      buildCompanionAdvertisementPayload({
        companionEnabled: false,
        endpoints: [endpoint],
      }),
    ).toEqual({ endpoints: [], capabilities: [] });
  });

  it('advertises legacy capabilities only when the companion REST surface is enabled', () => {
    expect(
      buildCompanionAdvertisementPayload({
        companionEnabled: true,
        machine,
        endpoints: [endpoint],
      }),
    ).toEqual({
      endpoints: [endpoint],
      capabilities: ['observe', 'approve', 'steer'],
      machine,
    });
  });
});
