import { describe, expect, it } from 'vitest';

import type { FairUseNotice } from '../../contract/auth';
import {
  FAIR_USE_NOTICE_MIN_MS,
  fairUseStatus,
  parseFairUseRestrictionCommand,
} from '../src/hosted/fair-use-policy';

const usage = { historyBytes: 12_345, artifactBytes: 67_890 };

describe('hosted fair-use policy', () => {
  it('keeps aggregate usage informational until an operator issues a notice', () => {
    expect(fairUseStatus(null, usage, Date.now())).toEqual({ status: 'clear', usage });
  });

  it('requires a visible seven-day notice before an ordinary restriction', () => {
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    const rejected = parseFairUseRestrictionCommand(
      {
        action: 'set',
        code: 'storage-usage',
        message: 'Please reduce stored artifacts.',
        restrictAt: new Date(now + FAIR_USE_NOTICE_MIN_MS - 1).toISOString(),
      },
      now,
      null,
    );
    expect(rejected).toEqual({ ok: false, reason: 'notice-period' });

    const accepted = parseFairUseRestrictionCommand(
      {
        action: 'set',
        code: 'storage-usage',
        message: 'Please reduce stored artifacts.',
        restrictAt: new Date(now + FAIR_USE_NOTICE_MIN_MS).toISOString(),
      },
      now,
      null,
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok && accepted.command.action === 'set') {
      expect(accepted.command.notice.noticeAt).toBe(new Date(now).toISOString());
      expect(fairUseStatus(accepted.command.notice, usage, now).status).toBe('notice');
      expect(
        fairUseStatus(
          accepted.command.notice,
          usage,
          Date.parse(accepted.command.notice.restrictAt),
        ).status,
      ).toBe('restricted');
    }
  });

  it('requires explicit emergency attribution and an immediate effective time', () => {
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    const input = {
      action: 'set',
      code: 'service-protection',
      message: 'We restricted writes to protect service availability.',
      restrictAt: new Date(now).toISOString(),
    };
    expect(parseFairUseRestrictionCommand(input, now, null)).toMatchObject({
      ok: false,
      reason: 'notice-period',
    });
    const emergency = parseFairUseRestrictionCommand({ ...input, emergency: true }, now, null);
    expect(emergency.ok).toBe(true);
    if (emergency.ok && emergency.command.action === 'set') {
      expect(emergency.command.notice.emergency).toBe(true);
      expect(fairUseStatus(emergency.command.notice, usage, now).status).toBe('restricted');
    }
  });

  it('preserves the original notice time when an operator updates a restriction', () => {
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    const previous: FairUseNotice = {
      code: 'storage-usage',
      message: 'Please reduce stored artifacts.',
      noticeAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      restrictAt: new Date(now + FAIR_USE_NOTICE_MIN_MS).toISOString(),
      emergency: false,
    };
    const updated = parseFairUseRestrictionCommand(
      {
        action: 'set',
        code: 'sustained-excessive-usage',
        message: 'Please contact support about sustained usage.',
        restrictAt: new Date(now + 31 * FAIR_USE_NOTICE_MIN_MS).toISOString(),
      },
      now,
      previous,
    );
    expect(updated.ok).toBe(true);
    if (updated.ok && updated.command.action === 'set') {
      expect(updated.command.notice.noticeAt).toBe(previous.noticeAt);
    }
  });

  it('does not let a repeat notice shorten the existing recovery window', () => {
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    const previous: FairUseNotice = {
      code: 'storage-usage',
      message: 'Please reduce stored artifacts.',
      noticeAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      restrictAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
      emergency: false,
    };
    const shortened = parseFairUseRestrictionCommand(
      {
        action: 'set',
        code: 'storage-usage',
        message: 'Please contact support about storage use.',
        restrictAt: new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString(),
      },
      now,
      previous,
    );
    expect(shortened).toEqual({ ok: false, reason: 'notice-period-shortened' });
  });
});
