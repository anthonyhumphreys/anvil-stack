export interface EphemeralEnvironmentEnrollmentCommand {
  apiUrl: string;
  enrollmentCode: string;
}

function usageError(message: string): Error {
  return new Error(
    `${message}\nUsage: anvil-daemon enroll-environment --api-url <url> --code <ephemeral-code> --worker`,
  );
}

function validateApiUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw usageError('enroll-environment --api-url must be an absolute URL');
  }

  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    /^127\./.test(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw usageError(
      'enroll-environment --api-url must use https (http is allowed only for loopback) and must not contain credentials, a query, or a fragment',
    );
  }
}

/**
 * Parse the image-only ephemeral environment bootstrap surface. The command
 * name and `--worker` flag are convenience only; the server-bound code class
 * remains the authority for whether this enrollment can be ephemeral.
 */
export function parseEphemeralEnvironmentEnrollmentCommand(
  args: readonly string[],
): EphemeralEnvironmentEnrollmentCommand {
  let apiUrl: string | undefined;
  let enrollmentCode: string | undefined;
  let worker = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--api-url') {
      if (apiUrl !== undefined) throw usageError('enroll-environment accepts one --api-url');
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--') || value.length === 0) {
        throw usageError('enroll-environment requires --api-url <url>');
      }
      apiUrl = value;
      index += 1;
      continue;
    }
    if (token === '--code') {
      if (enrollmentCode !== undefined) throw usageError('enroll-environment accepts one --code');
      const value = args[index + 1];
      if (
        value === undefined ||
        value.startsWith('--') ||
        value.length === 0 ||
        value.includes('\n') ||
        value.includes('\r')
      ) {
        throw usageError('enroll-environment requires --code <ephemeral-code>');
      }
      enrollmentCode = value;
      index += 1;
      continue;
    }
    if (token === '--worker') {
      if (worker) throw usageError('enroll-environment accepts --worker once');
      worker = true;
      continue;
    }
    throw usageError('unknown enroll-environment option');
  }

  if (apiUrl === undefined) throw usageError('enroll-environment requires --api-url <url>');
  if (enrollmentCode === undefined) {
    throw usageError('enroll-environment requires --code <ephemeral-code>');
  }
  if (!worker) throw usageError('enroll-environment requires --worker');
  validateApiUrl(apiUrl);
  return { apiUrl, enrollmentCode };
}
