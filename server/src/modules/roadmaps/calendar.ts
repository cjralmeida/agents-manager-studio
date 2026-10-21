/**
 * Working time of a workspace, for the roadmap's rates and forecasts: the days of the week and the hours people (or
 * agents) work, in the workspace's time zone, minus the pauses (time the work stopped for other reasons, e.g. fixing
 * the Studio). Rates measured over working time and forecasts walked over it use the same clock.
 */

export interface WorkCalendar {
  /** IANA time zone, e.g. America/Sao_Paulo. */
  timeZone: string;
  /** Working days, 0 = Sunday ... 6 = Saturday. */
  days: number[];
  /** Working hours "HH:MM"; start "00:00" and end "24:00" mean the whole day. */
  start: string;
  end: string;
}

export interface Interval {
  from: number;
  to: number;
}

export const ALL_DAY: Omit<WorkCalendar, 'timeZone'> = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' };
export const BUSINESS_HOURS: Omit<WorkCalendar, 'timeZone'> = { days: [1, 2, 3, 4, 5], start: '07:00', end: '17:00' };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/** Offset (ms) of a time zone at an instant: local wall time minus UTC. */
function offsetAt(timeZone: string, at: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return local - Math.floor(at / 1000) * 1000;
}

/** The local calendar day (YYYY-MM-DD) of an instant. */
export function localDay(timeZone: string, at: number) {
  return new Date(at + offsetAt(timeZone, at)).toISOString().slice(0, 10);
}

/** UTC instant a local day starts (00:00 in the time zone). */
export const dayStart = (timeZone: string, day: string) => instant(timeZone, day, 0);

/** UTC instant of a local wall time on a local day. */
function instant(timeZone: string, day: string, minutes: number) {
  const wall = Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;
  return wall - offsetAt(timeZone, wall - offsetAt(timeZone, wall));
}

/** The working windows that touch [from, to), in order. */
export function workingWindows(calendar: WorkCalendar, from: number, to: number): Interval[] {
  const windows: Interval[] = [];
  const start = minutesOf(calendar.start);
  const end = minutesOf(calendar.end);
  for (let day = localDay(calendar.timeZone, from - DAY); ; day = nextDay(day)) {
    const dayStart = instant(calendar.timeZone, day, 0);
    if (dayStart >= to) break;
    if (!calendar.days.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue;
    const window = { from: Math.max(from, instant(calendar.timeZone, day, start)), to: Math.min(to, instant(calendar.timeZone, day, end)) };
    if (window.to > window.from) windows.push(window);
  }
  return windows;
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + DAY).toISOString().slice(0, 10);

/** Intervals minus the pauses. */
export function subtract(intervals: Interval[], pauses: Interval[]): Interval[] {
  let result = intervals;
  for (const pause of pauses) {
    result = result.flatMap((interval) => {
      if (pause.to <= interval.from || pause.from >= interval.to) return [interval];
      const pieces: Interval[] = [];
      if (pause.from > interval.from) pieces.push({ from: interval.from, to: pause.from });
      if (pause.to < interval.to) pieces.push({ from: pause.to, to: interval.to });
      return pieces;
    });
  }
  return result;
}

/** Overlapping or touching intervals joined, in order. */
export function union(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].filter((interval) => interval.to > interval.from).sort((a, b) => a.from - b.from);
  const joined: Interval[] = [];
  for (const interval of sorted) {
    const last = joined.at(-1);
    if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to);
    else joined.push({ ...interval });
  }
  return joined;
}

export const totalMs = (intervals: Interval[]) => intervals.reduce((sum, interval) => sum + interval.to - interval.from, 0);

/** Productive working time in [from, to): working windows minus the pauses. */
export function workingMs(calendar: WorkCalendar, from: number, to: number, pauses: Interval[] = []) {
  return totalMs(subtract(workingWindows(calendar, from, to), pauses));
}

/**
 * Automatic pauses: stretches of working time longer than the threshold in which nothing was being worked on (no agent
 * running, no workflow run). Work that stopped for days (e.g. while the Studio was being fixed) does not lower the rate.
 */
export function idleGaps(calendar: WorkCalendar, activity: Interval[], from: number, to: number, thresholdMs: number): Interval[] {
  const busy = union(activity);
  const idle = subtract(workingWindows(calendar, from, to), busy);
  // Idle pieces split only by non-working time (a night, a weekend) count as one gap.
  const gaps: Interval[] = [];
  let current: { from: number; to: number; working: number } | null = null;
  for (const piece of idle) {
    const joins = current && !busy.some((interval) => interval.from < piece.from && interval.to > current!.to);
    if (current && joins) {
      current.to = piece.to;
      current.working += piece.to - piece.from;
    } else {
      if (current && current.working >= thresholdMs) gaps.push({ from: current.from, to: current.to });
      current = { from: piece.from, to: piece.to, working: piece.to - piece.from };
    }
  }
  if (current && current.working >= thresholdMs) gaps.push({ from: current.from, to: current.to });
  return gaps;
}

/** The instant reached after working for `ms` from `from` (skipping non-working time and pauses). */
export function addWorkingMs(calendar: WorkCalendar, from: number, ms: number, pauses: Interval[] = []) {
  let left = ms;
  let cursor = from;
  for (let guard = 0; guard < 400; guard += 1) {
    const span = 30 * DAY;
    for (const window of subtract(workingWindows(calendar, cursor, cursor + span), pauses)) {
      const length = window.to - window.from;
      if (length >= left) return window.from + left;
      left -= length;
    }
    cursor += span;
  }
  return cursor;
}
