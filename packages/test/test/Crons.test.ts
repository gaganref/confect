// oxlint-disable effecttsgo/global-date -- The cases name UTC instants as ISO strings, which plain `Date` reads and prints.
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Crons from "../src/internal/Crons";

const utc = (iso: string) => Date.parse(`${iso}Z`);
const iso = (ms: number) => new Date(ms).toISOString();

const spec = (schedule: Record<string, unknown>, name = "job") => {
  const parsed = Crons.parseSpec("", name, {
    name: "jobs:tick",
    args: [{}],
    schedule,
  });
  if (Result.isFailure(parsed)) throw parsed.failure;
  return parsed.success.schedule;
};

const refusal = (schedule: Record<string, unknown>, name = "job") => {
  const parsed = Crons.parseSpec("", name, {
    name: "jobs:tick",
    args: [{}],
    schedule,
  });
  return Result.isFailure(parsed) ? parsed.failure : undefined;
};

/**
 * A draw that records each bound it is asked for and answers `seconds`.
 */
const drawing = (seconds: number) => {
  const bounds: Array<number> = [];
  return {
    bounds,
    draw: (bound: number) => {
      bounds.push(bound);
      return seconds;
    },
  };
};

const never = (bound: number): number => {
  throw new Error(`No draw was expected, but one asked for [0, ${bound}).`);
};

const runs = (
  schedule: Crons.Schedule,
  now: string,
  count: number,
  draw: (bound: number) => number = never,
) => {
  const times: Array<string> = [];
  let at = Crons.nextRun(schedule, undefined, utc(now), draw);
  times.push(iso(at));
  for (let i = 1; i < count; i += 1) {
    at = Crons.following(schedule, at, at, draw).next;
    times.push(iso(at));
  }
  return times;
};

describe("intervals", () => {
  it("runs first when the job is declared, then each interval after the previous run's time", () => {
    const every = spec({ type: "interval", seconds: 30 });
    expect(runs(every, "2026-03-01T10:00:07.250", 3)).toEqual([
      "2026-03-01T10:00:07.250Z",
      "2026-03-01T10:00:37.250Z",
      "2026-03-01T10:01:07.250Z",
    ]);
  });

  it("reads minutes and hours as seconds", () => {
    expect(spec({ type: "interval", minutes: 2 })).toEqual({
      kind: "interval",
      seconds: 120,
    });
    expect(spec({ type: "interval", hours: 3 })).toEqual({
      kind: "interval",
      seconds: 10_800,
    });
  });

  it("anchors on the previous run's time, so a run that finishes late keeps the cadence", () => {
    const every = spec({ type: "interval", seconds: 30 });
    const due = utc("2026-03-01T10:00:00");
    expect(iso(Crons.following(every, due, due + 12_000, never).next)).toBe(
      "2026-03-01T10:00:30.000Z",
    );
  });

  it("skips every run already past when one finishes after several intervals", () => {
    const every = spec({ type: "interval", seconds: 30 });
    const due = utc("2026-03-01T10:00:00");
    const { next, skipped } = Crons.following(
      every,
      due,
      utc("2026-03-01T10:01:45"),
      never,
    );
    expect({ next: iso(next), skipped }).toEqual({
      next: "2026-03-01T10:02:00.000Z",
      skipped: 3,
    });
  });

  it("keeps a run due exactly as the previous one finishes", () => {
    const every = spec({ type: "interval", seconds: 30 });
    const due = utc("2026-03-01T10:00:00");
    expect(
      Crons.following(every, due, utc("2026-03-01T10:00:30"), never),
    ).toEqual({ next: utc("2026-03-01T10:00:30"), skipped: 0 });
  });
});

describe("clock schedules", () => {
  it("with no delay, a job declared exactly on an occurrence first runs at the next one", () => {
    const hourly = spec({ type: "hourly", minuteUTC: 30 });
    expect(runs(hourly, "2026-03-01T10:30:00", 2, () => 0)).toEqual([
      "2026-03-01T11:30:00.000Z",
      "2026-03-01T12:30:00.000Z",
    ]);
    expect(runs(hourly, "2026-03-01T10:29:59.999", 1, () => 0)).toEqual([
      "2026-03-01T10:30:00.000Z",
    ]);
  });

  it("delays a pinned minute's runs by one draw under 60 seconds, and keeps that delay from run to run", () => {
    const hourly = spec({ type: "hourly", minuteUTC: 30 });
    const { bounds, draw } = drawing(17);
    expect(runs(hourly, "2026-03-01T10:00:00", 3, draw)).toEqual([
      "2026-03-01T10:30:17.000Z",
      "2026-03-01T11:30:17.000Z",
      "2026-03-01T12:30:17.000Z",
    ]);
    expect(bounds).toEqual([60]);
  });

  it("draws again when the previous run carried no delay", () => {
    const daily = spec({ type: "daily", hourUTC: 4, minuteUTC: 5 });
    const { bounds, draw } = drawing(42);
    const next = Crons.following(
      daily,
      utc("2026-03-01T04:05:00"),
      utc("2026-03-01T04:05:00"),
      draw,
    ).next;
    expect(iso(next)).toBe("2026-03-02T04:05:42.000Z");
    expect(bounds).toEqual([60]);
  });

  it("spreads a schedule with no minute over its hour", () => {
    const hourly = spec({ type: "hourly" });
    const { bounds, draw } = drawing(1234);
    // The first run counts its fresh delay as already in effect, so it lands
    // in the current hour (`next_ts.rs:180-182`).
    expect(runs(hourly, "2026-03-01T10:15:00", 2, draw)).toEqual([
      "2026-03-01T10:20:34.000Z",
      "2026-03-01T11:20:34.000Z",
    ]);
    expect(bounds).toEqual([3600]);
  });

  it("runs a weekly schedule on its UTC weekday, Sunday first", () => {
    const sunday = spec({
      type: "weekly",
      dayOfWeek: "sunday",
      hourUTC: 23,
      minuteUTC: 59,
    });
    // 2026-03-01 is a Sunday.
    expect(runs(sunday, "2026-03-01T23:59:30", 2, () => 0)).toEqual([
      "2026-03-08T23:59:00.000Z",
      "2026-03-15T23:59:00.000Z",
    ]);
    const monday = spec({ type: "weekly", dayOfWeek: "monday", hourUTC: 0 });
    expect(runs(monday, "2026-03-01T23:59:30", 1, () => 0)).toEqual([
      "2026-03-02T00:00:00.000Z",
    ]);
  });

  it("runs a monthly schedule on its day, skipping months too short for it", () => {
    const last = spec({ type: "monthly", day: 31, hourUTC: 12, minuteUTC: 0 });
    expect(runs(last, "2026-01-31T12:00:00", 3, () => 0)).toEqual([
      "2026-03-31T12:00:00.000Z",
      "2026-05-31T12:00:00.000Z",
      "2026-07-31T12:00:00.000Z",
    ]);
    const leap = spec({ type: "monthly", day: 29, hourUTC: 0, minuteUTC: 0 });
    expect(runs(leap, "2027-01-29T00:00:00", 2, () => 0)).toEqual([
      "2027-03-29T00:00:00.000Z",
      "2027-04-29T00:00:00.000Z",
    ]);
    expect(runs(leap, "2028-01-29T00:00:00", 1, () => 0)).toEqual([
      "2028-02-29T00:00:00.000Z",
    ]);
  });

  it("crosses a year end and a European daylight saving change in plain UTC", () => {
    const daily = spec({ type: "daily", hourUTC: 1, minuteUTC: 30 });
    expect(runs(daily, "2026-12-31T02:00:00", 1, () => 0)).toEqual([
      "2027-01-01T01:30:00.000Z",
    ]);
    // Europe moves its clocks on 2026-03-29 at 01:00 UTC.
    expect(runs(daily, "2026-03-28T02:00:00", 2, () => 0)).toEqual([
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T01:30:00.000Z",
    ]);
  });
});

describe("cron expressions", () => {
  const at = (expression: string, now: string, count = 1) =>
    runs(spec({ type: "cron", cron: expression }), now, count, () => 0);

  it("steps, ranges and weekday names select their minutes", () => {
    expect(at("*/20 9-10 * * MON-FRI", "2026-03-06T10:40:00", 3)).toEqual([
      "2026-03-09T09:00:00.000Z",
      "2026-03-09T09:20:00.000Z",
      "2026-03-09T09:40:00.000Z",
    ]);
  });

  it("a day of the month and a weekday both restricted match either", () => {
    // Friday 2026-03-06, then the 13th, a Friday too, then Friday the 20th.
    expect(at("0 0 13 * FRI", "2026-03-05T12:00:00", 3)).toEqual([
      "2026-03-06T00:00:00.000Z",
      "2026-03-13T00:00:00.000Z",
      "2026-03-20T00:00:00.000Z",
    ]);
  });

  it("month names and lists select months, and a lone L is Saturday", () => {
    expect(at("0 6 1 JAN,jul *", "2026-02-01T00:00:00", 2)).toEqual([
      "2026-07-01T06:00:00.000Z",
      "2027-01-01T06:00:00.000Z",
    ]);
    expect(at("0 0 * * L", "2026-03-01T00:00:00")).toEqual([
      "2026-03-07T00:00:00.000Z",
    ]);
  });

  it("a wrapping range starts one value early, as saffron's does", () => {
    // `22-2` compiles to 21-23 and 0-2 (`saffron/src/lib.rs:495-509`).
    expect(at("0 22-2 * * *", "2026-03-01T03:00:00", 3)).toEqual([
      "2026-03-01T21:00:00.000Z",
      "2026-03-01T22:00:00.000Z",
      "2026-03-01T23:00:00.000Z",
    ]);
  });

  it("a cron expression's minute carries a delay under 60 seconds", () => {
    const { bounds, draw } = drawing(59);
    expect(
      runs(
        spec({ type: "cron", cron: "0 * * * *" }),
        "2026-03-01T10:00:00",
        2,
        draw,
      ),
    ).toEqual(["2026-03-01T10:00:59.000Z", "2026-03-01T11:00:59.000Z"]);
    expect(bounds).toEqual([60]);
  });
});

describe("declarations the binary refuses", () => {
  it.each([
    [
      { type: "interval", seconds: 0 },
      "Interval must be an integer greater than 0",
    ],
    [
      { type: "interval", seconds: 5, minutes: 1 },
      "Exactly one of (seconds, minutes, hours)",
    ],
    [{ type: "hourly", minuteUTC: 60 }, "minuteUTC must be 0-59"],
    [{ type: "daily", hourUTC: 24 }, "hourUTC must be 0-23"],
    [{ type: "monthly", day: 32, hourUTC: 0 }, "day of month must be 1-31"],
    [{ type: "weekly", dayOfWeek: "Monday", hourUTC: 0 }, "Invalid JSON"],
    [{ type: "cron", cron: "61 * * * *" }, "is not a cron expression"],
    [{ type: "cron", cron: "* * * * * *" }, "is not a cron expression"],
    [{ type: "cron", cron: "* * * * 7" }, "is not a cron expression"],
    [{ type: "cron", cron: " * * * * *" }, "is not a cron expression"],
    [{ type: "cron", cron: "* * 31 11 *" }, "will never match any time"],
  ])("%j is refused as invalid", (schedule, message) => {
    expect(refusal(schedule)).toMatchObject({
      _tag: "InvalidCron",
      name: "job",
      message: expect.stringContaining(message),
    });
  });

  it("refuses a name with a character outside printable ASCII", () => {
    expect(refusal({ type: "interval", seconds: 1 }, "tické")).toMatchObject({
      _tag: "InvalidCron",
    });
  });

  it.each([
    "0 0 L * *",
    "0 0 L-2W * *",
    "0 0 15W * *",
    "0 0 * * FRIL",
    "0 0 * * MON#2",
  ])(
    "%s parses in the binary but is refused as not simulated",
    (expression) => {
      expect(refusal({ type: "cron", cron: expression })).toMatchObject({
        _tag: "UnsupportedCronExpression",
        expression,
      });
    },
  );

  it("refuses an L form that would not parse as invalid, not as unsupported", () => {
    expect(refusal({ type: "cron", cron: "0 0 Lx * *" })).toMatchObject({
      _tag: "InvalidCron",
    });
  });
});
