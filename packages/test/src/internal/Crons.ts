/**
 * Convex's declared cron jobs, as the binary schedules them. A component's
 * `crons.ts` default export lists each job's function, arguments and schedule.
 * The binary turns that list into one standing job per name at push
 * (`crates/model/src/cron_jobs/mod.rs:151-223`, convex-backend
 * `precompiled-2026-10-28-cccbade`) and computes each run's time with
 * `compute_next_ts` (`crates/model/src/cron_jobs/next_ts.rs:132-189`). This
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
 * A minute, hour, day, month and weekday pattern. Each set holds the bit
 * positions saffron sets: minutes and hours by value, days of the month and
 * months from 0 for the first, weekdays from 0 for Sunday.
 */
export interface Pattern {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number> | "*";
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number> | "*";
}

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

export type Refusal =
  | KernelRefusal.InvalidCron
  | KernelRefusal.UnsupportedCronExpression;

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

class Unsupported {
  readonly _tag = "Unsupported";
  constructor(readonly feature: string) {}
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
 * `dom_expr` (`saffron/src/parse.rs:838-920`). The `L` and `W` forms parse in
 * the binary, but the kernel does not simulate them.
 */
const daysExpr = (cursor: Cursor): Array<Item> | "*" | Unsupported => {
  if (cursor.take("L")) {
    if (cursor.take("-") && cursor.number(1, 30) === undefined) {
      throw new Unparsed();
    }
    cursor.take("W");
    return new Unsupported("L in the day of the month");
  }
  if (cursor.peek() === "*") return listOrStar(cursor, daysField);
  const first = item(cursor, daysField);
  if (first.kind === "one" && cursor.take("W")) {
    return new Unsupported("W in the day of the month");
  }
  return tail(cursor, daysField, [first]);
};

/**
 * `dow_expr` (`saffron/src/parse.rs:927-1011`). A lone `L` is Saturday. A
 * weekday's `L` and `#` parse in the binary, but the kernel does not simulate
 * them.
 */
const weekdaysExpr = (cursor: Cursor): Array<Item> | "*" | Unsupported => {
  if (cursor.take("L")) return [{ kind: "one", at: 6 }];
  if (cursor.peek() === "*") return listOrStar(cursor, weekdaysField);
  const first = item(cursor, weekdaysField);
  if (first.kind === "one" && cursor.take("L")) {
    return new Unsupported("L after a weekday");
  }
  if (first.kind === "one" && cursor.take("#")) {
    if (cursor.number(1, 5) === undefined) throw new Unparsed();
    return new Unsupported("# in the day of the week");
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
): Result.Result<Pattern, Unparsed | Unsupported> => {
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
    if (days instanceof Unsupported) return Result.fail(days);
    if (weekdays instanceof Unsupported) return Result.fail(weekdays);
    return Result.succeed({
      minutes: compile(minutesField, minutes),
      hours: compile(hoursField, hours),
      days: days === "*" ? "*" : compile(daysField, days),
      months: compile(monthsField, months),
      weekdays: weekdays === "*" ? "*" : compile(weekdaysField, weekdays),
    });
  } catch (error) {
    if (error instanceof Unparsed) return Result.fail(error);
    throw error;
  }
};

// Calendar arithmetic in UTC, on days since the epoch.

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

const weekday = (days: number) => (((days + 4) % 7) + 7) % 7;

/**
 * `Cron::contains_date` (`saffron/src/lib.rs:992-1003`): the month matches, and
 * the day of the month or the weekday does. A `*` in one of them defers to the
 * other.
 */
const containsDate = (pattern: Pattern, days: number): boolean => {
  const { month, day: dom } = civil(days);
  if (!pattern.months.has(month - 1)) return false;
  const byDay = pattern.days === "*" || pattern.days.has(dom - 1);
  const byWeekday =
    pattern.weekdays === "*" || pattern.weekdays.has(weekday(days));
  if (pattern.days === "*") return byWeekday;
  if (pattern.weekdays === "*") return byDay;
  return byDay || byWeekday;
};

/**
 * A Gregorian cycle. A pattern no day of which matches inside one never
 * matches.
 */
const cycle = 146097;

/**
 * `Cron::next_after` (`saffron/src/lib.rs:1134-1141`): the first matching
 * minute after the minute holding `ts`, so never `ts` itself.
 */
export const nextOccurrenceAfter = (
  pattern: Pattern,
  ts: number,
): number | undefined => {
  const start = Math.floor(ts / minute) * minute + minute;
  const firstDay = Math.floor(start / day);
  const startMinute = (start - firstDay * day) / minute;
  for (let days = firstDay; days <= firstDay + cycle; days += 1) {
    if (!containsDate(pattern, days)) continue;
    const from = days === firstDay ? startMinute : 0;
    for (let h = Math.floor(from / 60); h < 24; h += 1) {
      if (!pattern.hours.has(h)) continue;
      const m0 = h === Math.floor(from / 60) ? from % 60 : 0;
      for (let m = m0; m < 60; m += 1) {
        if (pattern.minutes.has(m))
          return days * day + h * 60 * minute + m * minute;
      }
    }
  }
  return undefined;
};

/**
 * Whether a pattern can match at all, saffron's `Cron::any`
 * (`saffron/src/lib.rs:930-961`), which the binary checks at push
 * (`crates/model/src/cron_jobs/types.rs:453-459`).
 */
const any = (pattern: Pattern): boolean => {
  if (pattern.weekdays !== "*" || pattern.days === "*") return true;
  const first = Math.min(...pattern.days) + 1;
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
          return parsed.failure._tag === "Unsupported"
            ? Result.fail(
                new KernelRefusal.UnsupportedCronExpression({
                  componentPath,
                  name,
                  expression,
                  message: `Cron job "${name}" uses ${parsed.failure.feature} in "${expression}". The Convex binary accepts it, but the test kernel does not simulate it. Run this schedule against the binary.`,
                }),
              )
            : invalid(`"${expression}" is not a cron expression`);
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
  const all = (top: number) => new Set(range(0, top));
  const at = (n: number) => new Set([n]);
  const minutes =
    schedule.kind === "cron" ? undefined : at(schedule.minuteUTC ?? 0);
  switch (schedule.kind) {
    case "cron":
      return schedule.pattern;
    case "hourly":
      return {
        minutes: minutes!,
        hours: all(23),
        days: "*",
        months: all(11),
        weekdays: "*",
      };
    case "daily":
      return {
        minutes: minutes!,
        hours: at(schedule.hourUTC),
        days: "*",
        months: all(11),
        weekdays: "*",
      };
    case "weekly":
      return {
        minutes: minutes!,
        hours: at(schedule.hourUTC),
        days: "*",
        months: all(11),
        weekdays: at(schedule.dayOfWeek),
      };
    case "monthly":
      return {
        minutes: minutes!,
        hours: at(schedule.hourUTC),
        days: at(schedule.day - 1),
        months: all(11),
        weekdays: "*",
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
 * (`crates/model/src/cron_jobs/next_ts.rs:132-189`). An interval's first run is
 * due at once, and each later one an interval after the previous run's time. A
 * clock schedule's run is its next occurrence after `now`, less the previous
 * run's delay, plus the next run's delay. `draw(bound)` answers a whole number
 * of seconds in `[0, bound)`.
 */
export const nextRun = (
  schedule: Schedule,
  previous: number | undefined,
  now: number,
  draw: (bound: number) => number,
): number => {
  if (schedule.kind === "interval") {
    return previous === undefined ? now : previous + schedule.seconds * second;
  }
  const delay = splay(schedule, previous, draw);
  const occurrence = nextOccurrenceAfter(
    patternOf(schedule),
    now - delay.previous * second,
  );
  if (occurrence === undefined) {
    // `any` refused every pattern that never matches when the job was read.
    throw new Error(
      `Could not compute the next run of a "${schedule.kind}" cron.`,
    );
  }
  return occurrence + delay.next * second;
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
): { readonly next: number; readonly skipped: number } => {
  let next = nextRun(schedule, previous, now, draw);
  let skipped = 0;
  while (next < now) {
    skipped += 1;
    next = nextRun(schedule, next, now, draw);
  }
  return { next, skipped };
};
