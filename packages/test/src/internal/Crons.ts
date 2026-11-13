/**
 * Convex's declared cron jobs, as the binary schedules them. A component's
 * `crons.ts` default export lists each job's function, arguments and schedule.
 * The binary turns that list into one standing job per name at push
 * (`crates/model/src/cron_jobs/mod.rs:151-223`, convex-backend
 * `precompiled-2026-10-28-cccbade`) and computes each run's time with
 * `compute_next_ts` (`crates/model/src/cron_jobs/next_ts.rs:129-189`). This
 * module is that computation with no clock of its own: the caller passes the
 * time and a random draw.
 */

import type { Value } from "convex/values";
import { jsonToConvex } from "convex/values";
import * as Result from "effect/Result";
import * as KernelRefusal from "./KernelRefusal.js";

const second = 1000;
const minute = 60 * second;
const day = 24 * 60 * minute;

/**
 * The binary's `CRON_SPLAY_SECONDS` knob at its default
 * (`crates/common/src/knobs.rs:620-621`).
 */
const splaySeconds = 60;

/**
 * The day of the month, as saffron compiles it (`saffron/src/lib.rs:550-570`).
 * A pattern holds bit positions from 0 for the first day, and a wrapping step
 * may set bit 31, which no day reaches.
 */
export type DaysOfMonth =
  | { readonly kind: "star" }
  | { readonly kind: "pattern"; readonly bits: ReadonlySet<number> }
  /**
   * `L`, or `L-n` with `offset` n.
   */
  | { readonly kind: "last"; readonly offset: number }
  /**
   * `LW`, or `L-nW` with `offset` n.
   */
  | { readonly kind: "lastWeekday"; readonly offset: number }
  /**
   * `nW`, the weekday nearest day n.
   */
  | { readonly kind: "weekday"; readonly day: number };

/**
 * The day of the week, from 0 for Sunday, as saffron compiles it
 * (`saffron/src/lib.rs:86-98`). A wrapping step may set bit 7, which no weekday
 * reaches.
 */
export type DaysOfWeek =
  | { readonly kind: "star" }
  | { readonly kind: "pattern"; readonly bits: ReadonlySet<number> }
  /**
   * `nL`, the last weekday n of the month.
   */
  | { readonly kind: "last"; readonly weekday: number }
  /**
   * `n#k`, the k-th weekday n of the month.
   */
  | { readonly kind: "nth"; readonly weekday: number; readonly nth: number };

/**
 * A compiled cron expression. Minutes and hours hold their values, months hold
 * bit positions from 0 for January, and a wrapping step may set bit 12, which
 * no month reaches.
 */
export interface Pattern {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: DaysOfMonth;
  readonly months: ReadonlySet<number>;
  readonly weekdays: DaysOfWeek;
}

/**
 * Why a run's time could not be computed. `BinaryAborts`: saffron subtracts
 * below zero at `lib.rs:663`, and the binary is built with `overflow-checks =
 * true` and `panic = "abort"` (convex-backend `Cargo.toml:271-274`), so the
 * backend process aborts there. `NoOccurrence`: the search found no run, which
 * `compute_next_ts` reports as an error (`next_ts.rs:204-213`).
 */
export type SearchFailure =
  | { readonly _tag: "BinaryAborts"; readonly date: string }
  | { readonly _tag: "NoOccurrence" };

export type Schedule =
  | { readonly kind: "interval"; readonly seconds: number }
  | { readonly kind: "hourly"; readonly minuteUTC: number | undefined }
  | {
      readonly kind: "daily";
      readonly hourUTC: number;
      readonly minuteUTC: number | undefined;
    }
  | {
      readonly kind: "weekly";
      readonly dayOfWeek: number;
      readonly hourUTC: number;
      readonly minuteUTC: number | undefined;
    }
  | {
      readonly kind: "monthly";
      readonly day: number;
      readonly hourUTC: number;
      readonly minuteUTC: number | undefined;
    }
  | {
      readonly kind: "cron";
      readonly expression: string;
      readonly pattern: Pattern;
    };

/**
 * One declared job: its name, the function it runs as `module:export`, the
 * arguments and the schedule.
 */
export interface Spec {
  readonly name: string;
  readonly udfPath: string;
  readonly args: Value;
  readonly schedule: Schedule;
}

export type Refusal = KernelRefusal.InvalidCron;

// Cron expressions, as saffron parses and compiles them.

interface Field {
  /**
   * The values a number in the field may take.
   */
  readonly low: number;
  readonly high: number;
  /**
   * The highest bit the field's mask holds.
   */
  readonly top: number;
  /**
   * Saffron's `ExprValue::MIN` and `MAX`, in its value space. A wrapping step
   * reads them as bit positions (`saffron/src/lib.rs:418-425`), which is off by
   * one for days of the month, months and weekdays. The kernel keeps that.
   */
  readonly min: number;
  readonly max: number;
  readonly bit: (value: number) => number;
  /**
   * The bit `*` stands for inside a list, `ExprValue::min()`.
   */
  readonly starBit: number;
  /**
   * The largest step, `Step::MAX` (`saffron/src/parse.rs:436-442`).
   */
  readonly maxStep: number;
  readonly names?: ReadonlyArray<string>;
}

const minutesField: Field = {
  low: 0,
  high: 59,
  top: 59,
  min: 0,
  max: 59,
  bit: (v) => v,
  starBit: 0,
  maxStep: 59,
};
const hoursField: Field = {
  low: 0,
  high: 23,
  top: 23,
  min: 0,
  max: 23,
  bit: (v) => v,
  starBit: 0,
  maxStep: 23,
};
const daysField: Field = {
  low: 1,
  high: 31,
  top: 30,
  min: 1,
  max: 31,
  bit: (v) => v - 1,
  starBit: 0,
  maxStep: 30,
};
const monthsField: Field = {
  low: 1,
  high: 12,
  top: 11,
  min: 1,
  max: 12,
  bit: (v) => v - 1,
  starBit: 0,
  maxStep: 11,
  names: [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ],
};
const weekdaysField: Field = {
  low: 0,
  high: 6,
  top: 6,
  min: 1,
  max: 7,
  bit: (v) => v,
  starBit: 0,
  maxStep: 6,
  names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
};

/**
 * One list item, by bit position.
 */
type Item =
  | { readonly kind: "one"; readonly at: number }
  | { readonly kind: "range"; readonly from: number; readonly to: number }
  | {
      readonly kind: "step";
      readonly from: number;
      readonly to: number;
      readonly step: number;
    };

class Unparsed {
  readonly _tag = "Unparsed";
}

/**
 * A cursor over one field's text. Each reader throws `Unparsed` where saffron's
 * parser fails, so `parseExpression` turns any of them into one refusal.
 */
class Cursor {
  private at = 0;
  constructor(private readonly text: string) {}

  done() {
    return this.at === this.text.length;
  }

  peek() {
    return this.text[this.at];
  }

  take(char: string): boolean {
    if (this.text[this.at] !== char) return false;
    this.at += 1;
    return true;
  }

  /**
   * `digit1` parsed as a `u8`, then checked into `[low, high]`.
   */
  number(low: number, high: number): number | undefined {
    const match = /^[0-9]+/.exec(this.text.slice(this.at));
    if (match === null) return undefined;
    const value = Number(match[0]);
    if (value > 255 || value < low || value > high) return undefined;
    this.at += match[0].length;
    return value;
  }

  name(names: ReadonlyArray<string>): number | undefined {
    const word = this.text.slice(this.at, this.at + 3).toUpperCase();
    const index = names.indexOf(word);
    if (index === -1) return undefined;
    this.at += 3;
    return index;
  }
}

/**
 * A field value, by number then by name, as `alt((map_digit1, tag_no_case…))`
 * tries them. Returns its bit.
 */
const value = (cursor: Cursor, field: Field): number => {
  const n = cursor.number(field.low, field.high);
  if (n !== undefined) return field.bit(n);
  if (field.names !== undefined) {
    const index = cursor.name(field.names);
    if (index !== undefined) return index;
  }
  throw new Unparsed();
};

const stepOf = (cursor: Cursor, field: Field): number => {
  const step = cursor.number(1, field.maxStep);
  if (step === undefined) throw new Unparsed();
  return step;
};

/**
 * `ors_expr` (`saffron/src/parse.rs:690-717`): a value or `*`, then a step, a
 * range or a range with a step.
 */
const item = (cursor: Cursor, field: Field): Item => {
  const from = cursor.take("*") ? field.starBit : value(cursor, field);
  if (cursor.take("/")) {
    return { kind: "step", from, to: field.top, step: stepOf(cursor, field) };
  }
  if (cursor.take("-")) {
    const to = value(cursor, field);
    return cursor.take("/")
      ? { kind: "step", from, to, step: stepOf(cursor, field) }
      : { kind: "range", from, to };
  }
  return { kind: "one", at: from };
};

/**
 * `tail_ors_exprs`: further items after commas.
 */
const tail = (cursor: Cursor, field: Field, items: Array<Item>) => {
  while (cursor.take(",")) items.push(item(cursor, field));
  return items;
};

/**
 * `expr` (`saffron/src/parse.rs:744-783`) for minutes, hours and months: `*`,
 * `*` with a step, or a list.
 */
const listOrStar = (cursor: Cursor, field: Field): Array<Item> | "*" => {
  if (cursor.take("*")) {
    if (!cursor.take("/")) return "*";
    return tail(cursor, field, [
      {
        kind: "step",
        from: field.starBit,
        to: field.top,
        step: stepOf(cursor, field),
      },
    ]);
  }
  return tail(cursor, field, [item(cursor, field)]);
};

/**
 * `dom_expr` (`saffron/src/parse.rs:838-920`): `*`, a list, `L`, `L-n`, `LW`,
 * `L-nW` or `nW`.
 */
const daysExpr = (cursor: Cursor): Array<Item> | "*" | DaysOfMonth => {
  if (cursor.take("L")) {
    if (cursor.take("-")) {
      const offset = cursor.number(1, 30);
      if (offset === undefined) throw new Unparsed();
      return cursor.take("W")
        ? { kind: "lastWeekday", offset }
        : { kind: "last", offset };
    }
    return cursor.take("W")
      ? { kind: "lastWeekday", offset: 0 }
      : { kind: "last", offset: 0 };
  }
  if (cursor.peek() === "*") return listOrStar(cursor, daysField);
  const first = item(cursor, daysField);
  if (first.kind === "one" && cursor.take("W")) {
    return { kind: "weekday", day: first.at + 1 };
  }
  return tail(cursor, daysField, [first]);
};

/**
 * `dow_expr` (`saffron/src/parse.rs:927-1011`): `*`, a list, a lone `L` for
 * Saturday, `nL` or `n#k`.
 */
const weekdaysExpr = (cursor: Cursor): Array<Item> | "*" | DaysOfWeek => {
  if (cursor.take("L")) return [{ kind: "one", at: 6 }];
  if (cursor.peek() === "*") return listOrStar(cursor, weekdaysField);
  const first = item(cursor, weekdaysField);
  if (first.kind === "one" && cursor.take("L")) {
    return { kind: "last", weekday: first.at };
  }
  if (first.kind === "one" && cursor.take("#")) {
    const nth = cursor.number(1, 5);
    if (nth === undefined) throw new Unparsed();
    return { kind: "nth", weekday: first.at, nth };
  }
  return tail(cursor, weekdaysField, [first]);
};

/**
 * `OrsExpr::normalize` then the field's `add_ors`
 * (`saffron/src/parse.rs:561-570`, `saffron/src/lib.rs:374-430`). A wrapping
 * range starts one bit early, as saffron's does.
 */
const compile = (
  field: Field,
  items: Array<Item> | "*",
): ReadonlySet<number> => {
  const bits = new Set<number>();
  if (items === "*") {
    for (let at = 0; at <= field.top; at += 1) bits.add(at);
    return bits;
  }
  const span = (from: number, to: number) => {
    for (let at = from; at <= to; at += 1) if (at <= field.top) bits.add(at);
  };
  for (const raw of items) {
    const normal: Item =
      raw.kind !== "one" && raw.from === raw.to
        ? { kind: "one", at: raw.from }
        : raw.kind === "step" && raw.step === 1
          ? { kind: "range", from: raw.from, to: raw.to }
          : raw;
    switch (normal.kind) {
      case "one":
        bits.add(normal.at);
        break;
      case "range":
        if (normal.from <= normal.to) span(normal.from, normal.to);
        else {
          span(normal.from - 1, field.top);
          span(0, normal.to);
        }
        break;
      case "step": {
        const sequence =
          normal.from <= normal.to
            ? range(normal.from, normal.to)
            : [
                ...range(normal.from, field.max),
                ...range(field.min, normal.to),
              ];
        sequence.forEach((at, index) => {
          if (index % normal.step === 0) bits.add(at);
        });
        break;
      }
    }
  }
  return bits;
};

const range = (from: number, to: number): Array<number> =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

const fields = (expression: string): Array<string> | undefined => {
  if (!/^[^ \t]+([ \t]+[^ \t]+){4}$/.test(expression)) return undefined;
  return expression.split(/[ \t]+/);
};

/**
 * Parse a cron expression as saffron 1d84237 does: five fields separated by
 * spaces or tabs, minute, hour, day of the month, month and day of the week,
 * all in UTC.
 */
export const parseExpression = (
  expression: string,
): Result.Result<Pattern, Unparsed> => {
  const parts = fields(expression);
  if (parts === undefined) return Result.fail(new Unparsed());
  const [m, h, dom, mon, dow] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const read = <A>(text: string, parse: (cursor: Cursor) => A): A => {
    const cursor = new Cursor(text);
    const result = parse(cursor);
    if (!cursor.done()) throw new Unparsed();
    return result;
  };
  try {
    const minutes = read(m, (c) => listOrStar(c, minutesField));
    const hours = read(h, (c) => listOrStar(c, hoursField));
    const days = read(dom, daysExpr);
    const months = read(mon, (c) => listOrStar(c, monthsField));
    const weekdays = read(dow, weekdaysExpr);
    return Result.succeed({
      minutes: compile(minutesField, minutes),
      hours: compile(hoursField, hours),
      days:
        days === "*"
          ? { kind: "star" }
          : Array.isArray(days)
            ? { kind: "pattern", bits: compile(daysField, days) }
            : days,
      months: compile(monthsField, months),
      weekdays:
        weekdays === "*"
          ? { kind: "star" }
          : Array.isArray(weekdays)
            ? { kind: "pattern", bits: compile(weekdaysField, weekdays) }
            : weekdays,
    });
  } catch (error) {
    if (error instanceof Unparsed) return Result.fail(error);
    throw error;
  }
};

// Calendar arithmetic in UTC, on days since the epoch, standing in for
// chrono's `Date<Utc>`.

interface Civil {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Howard Hinnant's `civil_from_days`.
 */
const civil = (days: number): Civil => {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { year: era * 400 + yoe + (m <= 2 ? 1 : 0), month: m, day: d };
};

/**
 * Saffron's `days_in_month` (`saffron/src/lib.rs:26-45`).
 */
const daysInMonth = (year: number, month: number): number =>
  [1, 3, 5, 7, 8, 10, 12].includes(month)
    ? 31
    : month !== 2
      ? 30
      : year % 4 !== 0
        ? 28
        : year % 100 !== 0
          ? 29
          : year % 400 !== 0
            ? 28
            : 29;

/**
 * Chrono's `Utc.ymd_opt`: the date, or `undefined` when it does not exist.
 * Howard Hinnant's `days_from_civil`.
 */
const ymd = (year: number, month: number, d: number): number | undefined => {
  if (month < 1 || month > 12 || d < 1 || d > daysInMonth(year, month)) {
    return undefined;
  }
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

/**
 * Chrono's `with_day`: the same month at day `d`, if it exists.
 */
const withDay = (days: number, d: number): number | undefined => {
  const { year, month } = civil(days);
  return ymd(year, month, d);
};

const monthLength = (days: number) => {
  const { year, month } = civil(days);
  return daysInMonth(year, month);
};

/**
 * The weekday, from 0 for Sunday. 1970-01-01 was a Thursday.
 */
const weekday = (days: number) => (((days + 4) % 7) + 7) % 7;

const isWeekday = (days: number) => weekday(days) !== 0 && weekday(days) !== 6;

/**
 * The least member of `set` from `from` up and below `width`, as saffron's
 * `trailing_zeros` over a mask cleared below `from`; `width` when none.
 */
const lowest = (set: ReadonlySet<number>, from: number, width: number) => {
  let least = width;
  for (const at of set) if (at >= from && at < least) least = at;
  return least;
};

const abort = (days: number): never => {
  const { year, month, day: d } = civil(days);
  throw new Aborts(
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  );
};

class Aborts {
  readonly _tag = "BinaryAborts";
  constructor(readonly date: string) {}
}

/**
 * `DaysOfMonth::contains_date` (`saffron/src/lib.rs:623-678`). An `L-nW` test
 * on a Monday computes `day + n - days_in_month` in `u32` (`:663`). Below zero
 * that aborts the binary, so the kernel throws `Aborts` there.
 */
const dayContains = (days: DaysOfMonth, date: number): boolean => {
  const dim = monthLength(date);
  const d = civil(date).day;
  const wd = weekday(date);
  switch (days.kind) {
    case "pattern":
      return days.bits.has(d - 1);
    case "last":
      return d + days.offset === dim;
    case "lastWeekday": {
      if (days.offset === 0) {
        return (isWeekday(date) && d === dim) || (wd === 5 && dim - d < 3);
      }
      const offsetted = d + days.offset;
      return (
        (isWeekday(date) && offsetted === dim) ||
        (wd === 1 && (offsetted < dim ? abort(date) : offsetted - dim < 3)) ||
        (wd === 5 && offsetted + 1 === dim)
      );
    }
    case "weekday": {
      const expected = days.day;
      return (
        (isWeekday(date) && d === expected) ||
        (wd === 1 && d - 1 === expected) ||
        (wd === 1 && d === 3 && expected === 1) ||
        (wd === 5 && d + 1 === expected) ||
        (wd === 5 && d + 2 === expected && expected === dim)
      );
    }
    case "star":
      return true;
  }
};

/**
 * `DaysOfWeek::contains_date` (`saffron/src/lib.rs:153-173`).
 */
const weekdayContains = (weekdays: DaysOfWeek, date: number): boolean => {
  const wd = weekday(date);
  switch (weekdays.kind) {
    case "pattern":
      return weekdays.bits.has(wd);
    case "nth":
      return (
        weekdays.weekday === wd &&
        Math.floor((civil(date).day - 1) / 7) + 1 === weekdays.nth
      );
    case "last":
      return weekdays.weekday === wd && civil(date).day + 7 > monthLength(date);
    case "star":
      return true;
  }
};

/**
 * `Cron::contains_date` (`saffron/src/lib.rs:992-1003`): the month matches, and
 * the day of the month or the weekday does, the weekday tested first. A `*` in
 * one defers to the other.
 */
const containsDate = (pattern: Pattern, date: number): boolean => {
  if (!pattern.months.has(civil(date).month - 1)) return false;
  const dayStar = pattern.days.kind === "star";
  const weekdayStar = pattern.weekdays.kind === "star";
  if (dayStar && weekdayStar) return true;
  if (dayStar) return weekdayContains(pattern.weekdays, date);
  if (weekdayStar) return dayContains(pattern.days, date);
  return (
    weekdayContains(pattern.weekdays, date) || dayContains(pattern.days, date)
  );
};

/**
 * `find_next_day_of_month` (`saffron/src/lib.rs:1253-1310`).
 */
const nextDayOfMonth = (days: DaysOfMonth, start: number) => {
  const dim = monthLength(start);
  const near = (
    expected: number,
    date: number | undefined,
    lastSunday: boolean,
  ) => {
    if (date === undefined) return undefined;
    const wd = weekday(date);
    if (wd === 6 && expected === 1) return withDay(start, 3);
    if (wd === 6) return withDay(start, expected - 1);
    if (wd === 0 && lastSunday && expected === dim)
      return withDay(start, dim - 2);
    if (wd === 0) return withDay(start, expected + 1);
    return date;
  };
  const found = ((): number | undefined => {
    switch (days.kind) {
      case "last":
        return days.offset === 0
          ? withDay(start, dim)
          : dim < days.offset
            ? undefined
            : withDay(start, dim - days.offset);
      case "lastWeekday": {
        if (days.offset === 0) {
          const end = withDay(start, dim)!;
          const wd = weekday(end);
          return wd === 6
            ? withDay(start, dim - 1)
            : wd === 0
              ? withDay(start, dim - 2)
              : end;
        }
        if (dim < days.offset) return undefined;
        const expected = dim - days.offset;
        return near(expected, withDay(start, expected), false);
      }
      case "weekday":
        return near(days.day, withDay(start, days.day), true);
      case "pattern":
      case "star": {
        const bits = days.kind === "pattern" ? days.bits : new Set<number>();
        const at = lowest(bits, civil(start).day - 1, 31);
        return at < dim ? withDay(start, at + 1) : undefined;
      }
    }
  })();
  return found !== undefined && found >= start ? found : undefined;
};

/**
 * `find_next_weekday` (`saffron/src/lib.rs:1314-1387`).
 */
const nextWeekday = (weekdays: DaysOfWeek, start: number) => {
  const dim = monthLength(start);
  const day0 = civil(start).day - 1;
  const current = weekday(start);
  const firstOf = (target: number) =>
    (day0 + (target < current ? 7 - (current - target) : target - current)) % 7;
  const found = ((): number | undefined => {
    switch (weekdays.kind) {
      case "last": {
        const first = firstOf(weekdays.weekday);
        const fifth =
          (dim === 29 && first === 0) ||
          (dim === 30 && first <= 1) ||
          (dim === 31 && first <= 2);
        return withDay(start, first + (fifth ? 28 : 21) + 1);
      }
      case "nth":
        return withDay(
          start,
          firstOf(weekdays.weekday) + 7 * (weekdays.nth - 1) + 1,
        );
      case "pattern": {
        const map = new Set([...weekdays.bits].filter((at) => at <= 6));
        const next = lowest(map, current, 8);
        return withDay(
          start,
          (next < 8
            ? day0 + (next - current)
            : day0 + (6 - current) + 1 + lowest(map, 0, 8)) + 1,
        );
      }
      case "star":
        return start;
    }
  })();
  return found !== undefined && found >= start ? found : undefined;
};

/**
 * `find_next_day` (`saffron/src/lib.rs:1234-1250`).
 */
const nextDay = (pattern: Pattern, start: number) => {
  const dayStar = pattern.days.kind === "star";
  const weekdayStar = pattern.weekdays.kind === "star";
  if (dayStar && weekdayStar) return start;
  if (dayStar) return nextWeekday(pattern.weekdays, start);
  if (weekdayStar) return nextDayOfMonth(pattern.days, start);
  const byWeekday = nextWeekday(pattern.weekdays, start);
  const byDay = nextDayOfMonth(pattern.days, start);
  return byDay === undefined
    ? byWeekday
    : byWeekday === undefined
      ? byDay
      : Math.min(byDay, byWeekday);
};

/**
 * `find_next_month` (`saffron/src/lib.rs:1391-1401`). A bit past December has
 * no month, so it answers none.
 */
const nextMonth = (pattern: Pattern, start: number) => {
  const { year, month } = civil(start);
  const at = lowest(pattern.months, month - 1, 16);
  return at < 16 ? ymd(year, at + 1, 1) : undefined;
};

/**
 * `next_month_in_year` (`saffron/src/lib.rs:1460-1467`).
 */
const nextMonthInYear = (date: number) => {
  const { year, month } = civil(date);
  return month <= 11 ? ymd(year, month + 1, 1) : undefined;
};

/**
 * `find_next_date` (`saffron/src/lib.rs:1403-1436`), within one year.
 */
const nextDate = (pattern: Pattern, from: number): number | undefined => {
  let start = from;
  if (pattern.months.has(civil(start).month - 1)) {
    const found = nextDay(pattern, start);
    if (found !== undefined) return found;
  }
  for (;;) {
    const following = nextMonthInYear(start);
    if (following === undefined) return undefined;
    const month = nextMonth(pattern, following);
    if (month === undefined) return undefined;
    start = month;
    const found = nextDay(pattern, start);
    if (found !== undefined) return found;
  }
};

/**
 * `find_next_time` (`saffron/src/lib.rs:1178-1230`), in minutes of the day.
 */
const nextTime = (pattern: Pattern, from: number): number | undefined => {
  const hour = Math.floor(from / 60);
  if (pattern.hours.has(hour)) {
    const m = lowest(pattern.minutes, from % 60, 64);
    if (m < 64) return hour * 60 + m;
  }
  if (hour + 1 > 23) return undefined;
  const h = lowest(pattern.hours, hour + 1, 32);
  if (h >= 32) return undefined;
  const m = lowest(pattern.minutes, 0, 64);
  return m < 64 ? h * 60 + m : undefined;
};

/**
 * The last year chrono's `MAX_DATETIME` reaches, where saffron's search stops.
 */
const lastYear = 262_143;

/**
 * `Cron::next_after` (`saffron/src/lib.rs:1134-1174`): the first run after the
 * minute holding `ts`, so never `ts` itself. The first day is tested with
 * `contains_date`, and every later one is found by saffron's day search, as
 * saffron does.
 */
export const nextOccurrenceAfter = (
  pattern: Pattern,
  ts: number,
): Result.Result<number, SearchFailure> => {
  const start = Math.floor(ts / minute) * minute + minute;
  const date = Math.floor(start / day);
  try {
    if (!any(pattern)) return Result.fail({ _tag: "NoOccurrence" });
    if (containsDate(pattern, date)) {
      const time = nextTime(pattern, (start - date * day) / minute);
      if (time !== undefined) return Result.succeed(date * day + time * minute);
    }
    let search = date + 1;
    for (;;) {
      const found = nextDate(pattern, search);
      if (found !== undefined) {
        const time = nextTime(pattern, 0);
        return time === undefined
          ? Result.fail({ _tag: "NoOccurrence" })
          : Result.succeed(found * day + time * minute);
      }
      const year = civil(search).year + 1;
      if (year > lastYear) return Result.fail({ _tag: "NoOccurrence" });
      search = ymd(year, 1, 1)!;
    }
  } catch (error) {
    if (error instanceof Aborts) {
      return Result.fail({ _tag: "BinaryAborts", date: error.date });
    }
    throw error;
  }
};

/**
 * Whether a pattern can match at all, saffron's `Cron::any`
 * (`saffron/src/lib.rs:930-961`), which the binary checks at push
 * (`crates/model/src/cron_jobs/types.rs:453-459`). For `nW` it reads the day's
 * own bits, as saffron does.
 */
const any = (pattern: Pattern): boolean => {
  const days = pattern.days;
  if (pattern.weekdays.kind !== "star" || days.kind === "star") return true;
  const trailing = (n: number) => (n === 0 ? 32 : 31 - Math.clz32(n & -n));
  let first: number;
  if (days.kind === "last" || days.kind === "lastWeekday") {
    if (days.offset === 0) return true;
    first = days.offset + 1;
  } else if (days.kind === "weekday") {
    first = trailing(days.day) + 1;
  } else {
    first = lowest(days.bits, 0, 32) + 1;
  }
  const months = [...pattern.months];
  const longest = months.some((m) => [0, 2, 4, 6, 7, 9, 11].includes(m))
    ? 31
    : months.some((m) => [3, 5, 8, 10].includes(m))
      ? 30
      : 29;
  return first <= longest;
};

// Declared specs.

const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const isInt = (n: unknown): n is number => Number.isInteger(n);

/**
 * Read one entry of a `Crons` object's `export()`, as
 * `CronSpec::from_exported_json` does
 * (`crates/model/src/cron_jobs/types.rs:270-478`).
 */
export const parseSpec = (
  componentPath: string,
  name: string,
  json: unknown,
): Result.Result<Spec, Refusal> => {
  const invalid = (reason: string) =>
    Result.fail(
      new KernelRefusal.InvalidCron({
        componentPath,
        name,
        message: `Cron job "${name}" is invalid: ${reason}.`,
      }),
    );
  for (const c of name) {
    const code = c.charCodeAt(0);
    if (c.length !== 1 || code > 127 || code < 32 || code === 127) {
      return invalid(
        `its name has the character '${c}', and a cron name holds only ASCII characters that are not control characters`,
      );
    }
  }
  const entry = json as {
    name?: unknown;
    args?: unknown;
    schedule?: Record<string, unknown>;
  };
  if (
    typeof entry?.name !== "string" ||
    !Array.isArray(entry.args) ||
    typeof entry.schedule !== "object" ||
    entry.schedule === null
  ) {
    return invalid("Invalid JSON");
  }
  const s = entry.schedule;
  const minuteOf = (): Result.Result<number | undefined, Refusal> =>
    s["minuteUTC"] === undefined
      ? Result.succeed(undefined)
      : isInt(s["minuteUTC"]) && s["minuteUTC"] >= 0 && s["minuteUTC"] <= 59
        ? Result.succeed(s["minuteUTC"])
        : invalid("minuteUTC must be 0-59");
  const hourOf = (): Result.Result<number, Refusal> =>
    isInt(s["hourUTC"]) && s["hourUTC"] >= 0 && s["hourUTC"] <= 23
      ? Result.succeed(s["hourUTC"])
      : invalid("hourUTC must be 0-23");
  const schedule = ((): Result.Result<Schedule, Refusal> => {
    switch (s["type"]) {
      case "interval": {
        const given = (["seconds", "minutes", "hours"] as const).filter(
          (unit) => s[unit] !== undefined,
        );
        if (given.length !== 1) {
          return invalid(
            "Exactly one of (seconds, minutes, hours) should be specified",
          );
        }
        const amount = s[given[0]!];
        if (!isInt(amount)) return invalid("Invalid JSON");
        if (amount <= 0) {
          return invalid("Interval must be an integer greater than 0");
        }
        const scale = { seconds: 1, minutes: 60, hours: 3600 }[given[0]!];
        return Result.succeed({ kind: "interval", seconds: amount * scale });
      }
      case "hourly":
        return Result.map(minuteOf(), (minuteUTC) => ({
          kind: "hourly" as const,
          minuteUTC,
        }));
      case "daily":
        return Result.flatMap(minuteOf(), (minuteUTC) =>
          Result.map(hourOf(), (hourUTC) => ({
            kind: "daily" as const,
            hourUTC,
            minuteUTC,
          })),
        );
      case "weekly": {
        const dayOfWeek = weekdays.indexOf(s["dayOfWeek"] as string);
        if (dayOfWeek === -1) return invalid("Invalid JSON");
        return Result.flatMap(minuteOf(), (minuteUTC) =>
          Result.map(hourOf(), (hourUTC) => ({
            kind: "weekly" as const,
            dayOfWeek,
            hourUTC,
            minuteUTC,
          })),
        );
      }
      case "monthly":
        return Result.flatMap(minuteOf(), (minuteUTC) =>
          Result.flatMap(hourOf(), (hourUTC) =>
            isInt(s["day"]) && s["day"] >= 1 && s["day"] <= 31
              ? Result.succeed({
                  kind: "monthly" as const,
                  day: s["day"],
                  hourUTC,
                  minuteUTC,
                })
              : invalid("day of month must be 1-31"),
          ),
        );
      case "cron": {
        const expression = s["cron"];
        if (typeof expression !== "string") return invalid("Invalid JSON");
        const parsed = parseExpression(expression);
        if (Result.isFailure(parsed)) {
          return invalid(`"${expression}" is not a cron expression`);
        }
        if (!any(parsed.success)) {
          return invalid(
            `The cron spec "${expression}" will never match any time`,
          );
        }
        return Result.succeed({
          kind: "cron",
          expression,
          pattern: parsed.success,
        });
      }
      default:
        return invalid("Invalid JSON");
    }
  })();
  return Result.map(schedule, (read) => ({
    name,
    udfPath: canonical(entry.name as string),
    args: jsonToConvex((entry.args as Array<never>)[0] ?? {}) as Value,
    schedule: read,
  }));
};

/**
 * A function path with its module's extension dropped, as the binary
 * canonicalizes `UdfPath`.
 */
const canonical = (udfPath: string): string => {
  const [module, exportName = "default"] = udfPath.split(":") as [
    string,
    string | undefined,
  ];
  return `${module.replace(/\.js$/, "")}:${exportName}`;
};

// Next runs.

/**
 * The pattern a clock schedule runs on, as `compute_next_ts` formats it
 * (`crates/model/src/cron_jobs/next_ts.rs:145-172`). An omitted minute is
 * minute 0, which the splay then spreads over the hour.
 */
const patternOf = (
  schedule: Exclude<Schedule, { kind: "interval" }>,
): Pattern => {
  if (schedule.kind === "cron") return schedule.pattern;
  const all = (top: number) => new Set(range(0, top));
  const at = (n: number) => new Set([n]);
  const minutes = at(schedule.minuteUTC ?? 0);
  const months = all(11);
  const star = { kind: "star" } as const;
  switch (schedule.kind) {
    case "hourly":
      return { minutes, hours: all(23), days: star, months, weekdays: star };
    case "daily":
      return {
        minutes,
        hours: at(schedule.hourUTC),
        days: star,
        months,
        weekdays: star,
      };
    case "weekly":
      return {
        minutes,
        hours: at(schedule.hourUTC),
        days: star,
        months,
        weekdays: { kind: "pattern", bits: at(schedule.dayOfWeek) },
      };
    case "monthly":
      return {
        minutes,
        hours: at(schedule.hourUTC),
        days: { kind: "pattern", bits: at(schedule.day - 1) },
        months,
        weekdays: star,
      };
  }
};

/**
 * `cron_splay` (`crates/model/src/cron_jobs/next_ts.rs:56-127`): the delay, in
 * seconds, the previous run had and the one the next run gets. An interval
 * never splays. A schedule with no minute splays over the hour, any other over
 * its minute. The previous run's time carries its delay.
 */
const splay = (
  schedule: Schedule,
  previous: number | undefined,
  draw: (bound: number) => number,
): { readonly previous: number; readonly next: number } => {
  if (schedule.kind === "interval") return { previous: 0, next: 0 };
  const spread =
    schedule.kind !== "cron" && schedule.minuteUTC === undefined
      ? { max: 3600, period: 3600 }
      : { max: splaySeconds, period: 60 };
  if (previous === undefined) {
    const delay = draw(spread.max);
    return { previous: delay, next: delay };
  }
  const delay = Math.floor(previous / second) % spread.period;
  return delay !== 0
    ? { previous: delay, next: delay }
    : { previous: 0, next: draw(spread.max) };
};

/**
 * The time of the run after `previous`, or of the first run when there is none,
 * at time `now`, as `compute_next_ts` computes it
 * (`crates/model/src/cron_jobs/next_ts.rs:129-189`). An interval's first run is
 * due at once, and each later one an interval after the previous run's time. A
 * clock schedule's run is its next occurrence after `now` less the previous
 * run's delay, plus the next run's delay. When `now` is no later than that
 * delay, the binary's checked subtraction fails and it searches from `now`
 * itself (`next_ts.rs:180`, `Timestamp::sub` in
 * `crates/convex/sync_types/src/timestamp.rs:72-78`). `draw(bound)` answers a
 * whole number of seconds in `[0, bound)`.
 */
export const nextRun = (
  schedule: Schedule,
  previous: number | undefined,
  now: number,
  draw: (bound: number) => number,
): Result.Result<number, SearchFailure> => {
  if (schedule.kind === "interval") {
    return Result.succeed(
      previous === undefined ? now : previous + schedule.seconds * second,
    );
  }
  const delay = splay(schedule, previous, draw);
  const back = delay.previous * second;
  return Result.map(
    nextOccurrenceAfter(patternOf(schedule), now > back ? now - back : now),
    (occurrence) => occurrence + delay.next * second,
  );
};

/**
 * The run after a run that was due at `previous` and finished at `now`. The
 * binary skips every run that would already be past (`complete_job_run`,
 * `crates/application/src/cron_jobs/mod.rs:852-871`).
 */
export const following = (
  schedule: Schedule,
  previous: number,
  now: number,
  draw: (bound: number) => number,
): Result.Result<
  { readonly next: number; readonly skipped: number },
  SearchFailure
> => {
  let next = nextRun(schedule, previous, now, draw);
  let skipped = 0;
  while (Result.isSuccess(next) && next.success < now) {
    skipped += 1;
    next = nextRun(schedule, next.success, now, draw);
  }
  return Result.map(next, (at) => ({ next: at, skipped }));
};
