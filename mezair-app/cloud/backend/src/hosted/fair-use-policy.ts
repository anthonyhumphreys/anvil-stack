import type {
  FairUseAccountStatus,
  FairUseNotice,
  FairUseRestrictionCode,
} from '../../../contract/auth';

export const FAIR_USE_NOTICE_MIN_MS = 7 * 24 * 60 * 60 * 1000;
export const FAIR_USE_EMERGENCY_MAX_SKEW_MS = 5 * 60 * 1000;
const FAIR_USE_MESSAGE_MAX_LENGTH = 500;

export type FairUseRestrictionCommand =
  | { action: 'clear' }
  | { action: 'set'; notice: FairUseNotice };

export type FairUseRestrictionCommandResult =
  | { ok: true; command: FairUseRestrictionCommand }
  | { ok: false; reason: string };

const RESTRICTION_CODES: readonly FairUseRestrictionCode[] = [
  'storage-usage',
  'sustained-excessive-usage',
  'service-protection',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isRestrictionCode(value: unknown): value is FairUseRestrictionCode {
  return typeof value === 'string' && RESTRICTION_CODES.includes(value as FairUseRestrictionCode);
}

export function parseFairUseRestrictionCommand(
  input: unknown,
  now: number,
  previous: FairUseNotice | null,
): FairUseRestrictionCommandResult {
  if (!isRecord(input)) return { ok: false, reason: 'body' };
  if (input['action'] === 'clear') return { ok: true, command: { action: 'clear' } };
  if (input['action'] !== 'set') return { ok: false, reason: 'action' };

  const code = input['code'];
  const message = input['message'];
  const restrictAt = input['restrictAt'];
  const emergencyRaw = input['emergency'];
  if (!isRestrictionCode(code)) return { ok: false, reason: 'code' };
  if (
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > FAIR_USE_MESSAGE_MAX_LENGTH ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(message)
  ) {
    return { ok: false, reason: 'message' };
  }
  if (!canonicalTimestamp(restrictAt)) return { ok: false, reason: 'restrictAt' };
  if (emergencyRaw !== undefined && typeof emergencyRaw !== 'boolean') {
    return { ok: false, reason: 'emergency' };
  }

  const emergency = emergencyRaw === true;
  const restrictionTime = Date.parse(restrictAt);
  if (emergency) {
    if (Math.abs(restrictionTime - now) > FAIR_USE_EMERGENCY_MAX_SKEW_MS) {
      return { ok: false, reason: 'emergency-restrictAt' };
    }
  } else if (restrictionTime < now + FAIR_USE_NOTICE_MIN_MS) {
    return { ok: false, reason: 'notice-period' };
  } else if (previous !== null && restrictionTime < Date.parse(previous.restrictAt)) {
    return { ok: false, reason: 'notice-period-shortened' };
  }

  return {
    ok: true,
    command: {
      action: 'set',
      notice: {
        code,
        message: message.trim(),
        noticeAt: previous?.noticeAt ?? new Date(now).toISOString(),
        restrictAt,
        emergency,
      },
    },
  };
}

/** Parses only values previously written by this module; malformed state fails closed. */
export function parseStoredFairUseNotice(raw: string | null): FairUseNotice | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Stored fair-use restriction is not valid JSON.');
  }
  if (
    !isRecord(value) ||
    !isRestrictionCode(value['code']) ||
    typeof value['message'] !== 'string' ||
    value['message'].trim().length === 0 ||
    value['message'].length > FAIR_USE_MESSAGE_MAX_LENGTH ||
    !canonicalTimestamp(value['noticeAt']) ||
    !canonicalTimestamp(value['restrictAt']) ||
    typeof value['emergency'] !== 'boolean'
  ) {
    throw new Error('Stored fair-use restriction is malformed.');
  }
  return {
    code: value['code'],
    message: value['message'],
    noticeAt: value['noticeAt'],
    restrictAt: value['restrictAt'],
    emergency: value['emergency'],
  };
}

export function fairUseStatus(
  notice: FairUseNotice | null,
  usage: FairUseAccountStatus['usage'],
  now: number,
): FairUseAccountStatus {
  if (notice === null) return { status: 'clear', usage };
  return {
    status: now >= Date.parse(notice.restrictAt) ? 'restricted' : 'notice',
    usage,
    notice,
  };
}
