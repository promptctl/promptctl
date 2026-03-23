// Minimal cron expression parser: minute hour day-of-month month day-of-week
// Supports: numbers, *, */N, ranges (1-5), lists (1,3,5)

export interface CronExpression {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  const values: number[] = [];

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.push(i);
    } else if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      for (let i = min; i <= max; i += step) values.push(i);
    } else if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) values.push(i);
    } else {
      values.push(parseInt(part, 10));
    }
  }

  return values.filter((v) => v >= min && v <= max).sort((a, b) => a - b);
}

export function parseCron(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expression}": expected 5 fields`,
    );
  }

  return {
    minutes: parseField(fields[0], 0, 59),
    hours: parseField(fields[1], 0, 23),
    daysOfMonth: parseField(fields[2], 1, 31),
    months: parseField(fields[3], 1, 12),
    daysOfWeek: parseField(fields[4], 0, 6),
  };
}

export function nextCronOccurrence(
  cron: CronExpression,
  after: Date = new Date(),
): Date {
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Brute force: check each minute for up to 1 year
  const limit = 365 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (
      cron.months.includes(candidate.getMonth() + 1) &&
      cron.daysOfMonth.includes(candidate.getDate()) &&
      cron.daysOfWeek.includes(candidate.getDay()) &&
      cron.hours.includes(candidate.getHours()) &&
      cron.minutes.includes(candidate.getMinutes())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error("No matching cron occurrence found within 1 year");
}
