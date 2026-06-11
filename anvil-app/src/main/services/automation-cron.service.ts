const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parsePart(part: string, min: number, max: number): CronField {
  const trimmed = part.trim();
  if (trimmed === '*') {
    return {
      wildcard: true,
      values: new Set(Array.from({ length: max - min + 1 }, (_, index) => min + index)),
    };
  }

  const values = new Set<number>();
  for (const segment of trimmed.split(',')) {
    const piece = segment.trim();
    if (!piece) {
      throw new Error(`Invalid cron segment: "${part}"`);
    }

    if (piece.startsWith('*/')) {
      const step = Number(piece.slice(2));
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Invalid cron step: "${piece}"`);
      }
      for (let value = min; value <= max; value += step) {
        values.add(value);
      }
      continue;
    }

    if (piece.includes('-')) {
      const [startRaw, endRaw] = piece.split('-', 2);
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        throw new Error(`Invalid cron range: "${piece}"`);
      }
      if (start < min || end > max) {
        throw new Error(`Cron range out of bounds: "${piece}"`);
      }
      for (let value = start; value <= end; value += 1) {
        values.add(value);
      }
      continue;
    }

    const value = Number(piece);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Cron value out of bounds: "${piece}"`);
    }
    values.add(value);
  }

  if (values.size === 0) {
    throw new Error(`Cron segment resolves to no values: "${part}"`);
  }

  return { values, wildcard: false };
}

function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('Cron expression must have exactly 5 fields.');
  }

  return {
    minute: parsePart(parts[0], 0, 59),
    hour: parsePart(parts[1], 0, 23),
    dayOfMonth: parsePart(parts[2], 1, 31),
    month: parsePart(parts[3], 1, 12),
    dayOfWeek: parsePart(parts[4], 0, 6),
  };
}

function getFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
}

function getZonedParts(date: Date, timezone: string): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const formatter = getFormatter(timezone);
  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    minute: Number(lookup.minute),
    hour: Number(lookup.hour),
    dayOfMonth: Number(lookup.day),
    month: Number(lookup.month),
    dayOfWeek: WEEKDAY_INDEX[lookup.weekday] ?? 0,
  };
}

function matches(parsed: ParsedCron, date: Date, timezone: string): boolean {
  const zoned = getZonedParts(date, timezone);
  return (
    parsed.minute.values.has(zoned.minute) &&
    parsed.hour.values.has(zoned.hour) &&
    parsed.dayOfMonth.values.has(zoned.dayOfMonth) &&
    parsed.month.values.has(zoned.month) &&
    parsed.dayOfWeek.values.has(zoned.dayOfWeek)
  );
}

export function validateAutomationCron(expression: string, timezone: string): void {
  parseCron(expression);
  getFormatter(timezone).format(new Date());
}

export function getNextAutomationRunAt(
  expression: string,
  timezone: string,
  fromDate = new Date(),
): string {
  const parsed = parseCron(expression);
  getFormatter(timezone).format(fromDate);

  const cursor = new Date(fromDate.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const maxIterations = 60 * 24 * 366;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (matches(parsed, cursor, timezone)) {
      return cursor.toISOString();
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  throw new Error('Unable to resolve the next run time within one year.');
}
