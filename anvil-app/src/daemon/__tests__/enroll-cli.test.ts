import { describe, expect, it } from 'vitest';
import { parseEphemeralEnvironmentEnrollmentCommand } from '../enroll-cli.js';

const CODE = 'anvil-ec-ephemeral-secret';

describe('ephemeral environment enrollment command parsing', () => {
  it('accepts only an API URL, plain code, and explicit worker flag', () => {
    expect(
      parseEphemeralEnvironmentEnrollmentCommand([
        '--api-url',
        'https://sync.example',
        '--code',
        CODE,
        '--worker',
      ]),
    ).toEqual({ apiUrl: 'https://sync.example', enrollmentCode: CODE });
    expect(
      parseEphemeralEnvironmentEnrollmentCommand([
        '--worker',
        '--code',
        CODE,
        '--api-url',
        'http://127.0.0.1:8787',
      ]),
    ).toEqual({ apiUrl: 'http://127.0.0.1:8787', enrollmentCode: CODE });
  });

  it('rejects pairing payloads, omitted worker opt-in, and malformed arguments', () => {
    expect(() =>
      parseEphemeralEnvironmentEnrollmentCommand([
        '--api-url',
        'https://sync.example',
        '--pair',
        'anvil-pair-secret',
        '--worker',
      ]),
    ).toThrow('unknown enroll-environment option');
    expect(() =>
      parseEphemeralEnvironmentEnrollmentCommand([
        '--api-url',
        'https://sync.example',
        '--code',
        CODE,
      ]),
    ).toThrow('requires --worker');
    expect(() =>
      parseEphemeralEnvironmentEnrollmentCommand([
        '--api-url',
        'https://sync.example?token=secret',
        '--code',
        CODE,
        '--worker',
      ]),
    ).toThrow('must use https');
    expect(() =>
      parseEphemeralEnvironmentEnrollmentCommand([
        '--api-url',
        'https://sync.example',
        '--code',
        `${CODE}\nforged`,
        '--worker',
      ]),
    ).toThrowError(expect.not.stringContaining(CODE));
  });
});
