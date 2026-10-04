import { BackendRpcError } from './sync-backend-client.service.js';

/** Explain a rejected remote dispatch without echoing arbitrary backend text. */
export function describeMeshDispatchError(error: unknown): string {
  if (!(error instanceof BackendRpcError)) {
    return error instanceof Error ? error.message : String(error);
  }
  if (error.code !== 'forbidden') return error.message;

  switch (error.details?.['reason']) {
    case 'target-not-eligible':
      return 'The selected device is not eligible for Mesh jobs. On that device, enable the worker, run the daemon, and check that its policy allows jobs from this device.';
    case 'source-not-allowed':
      return 'The target worker does not allow jobs from this device. Check its Mesh worker policy.';
    case 'worker-policy-required':
    case 'jobs-not-allowed':
      return 'The target device has not enabled Mesh jobs. Enable its worker and run the daemon.';
    case 'worker-revoked':
      return 'The target worker has been revoked. Enroll a new device before sending jobs to it.';
    case 'billing-unavailable':
    case 'preview-ended':
    case 'subscription-required':
      return 'This backend still restricts Mesh by subscription. Update the backend to use free Sync and Mesh.';
    case 'account-deleted':
      return 'This account is no longer active on the backend.';
    default:
      return 'The backend refused this Mesh dispatch. Check Hosted access and the target device’s worker status.';
  }
}
