import { describe, expect, it } from 'vitest';
import {
  getNextAutomationRunAt,
  validateAutomationCron,
} from '../automation-cron.service.js';

describe('automation cron service', () => {
  it('validates a simple weekday schedule', () => {
    expect(() => validateAutomationCron('0 9 * * 1-5', 'Europe/London')).not.toThrow();
  });

  it('rejects malformed cron expressions', () => {
    expect(() => validateAutomationCron('0 9 * *', 'Europe/London')).toThrow(
      /exactly 5 fields/i,
    );
  });

  it('finds the next matching run time for a daily schedule', () => {
    const next = getNextAutomationRunAt('0 9 * * *', 'UTC', new Date('2026-04-29T08:15:00.000Z'));
    expect(next).toBe('2026-04-29T09:00:00.000Z');
  });

  it('supports stepped schedules', () => {
    const next = getNextAutomationRunAt('*/30 * * * *', 'UTC', new Date('2026-04-29T08:15:00.000Z'));
    expect(next).toBe('2026-04-29T08:30:00.000Z');
  });
});
