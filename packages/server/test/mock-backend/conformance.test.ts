import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { exceptions, refusals, type ConformanceException } from "./conformance";

const entry: ConformanceException = {
  file: "egress.test.ts",
  name: "action egress > a raw fetch dies",
  convexTest: "0.0.65",
  binary: "The binary performs the fetch.",
  outcomes: [{ function: "egress:rawFetch", returned: "reached /ping" }],
  departure: "expected 'reached /ping' to be 'refused'",
  owner: "kernel",
  evidence: "ioBans.test.ts",
};

const cases = ["action egress > a raw fetch dies", "action egress > other"];

describe("conformance exceptions", () => {
  it("an entry that names one case exactly holds", () => {
    expect(refusals(entry, cases, "0.0.65")).toEqual([]);
  });

  it("a describe block is refused", () => {
    expect(
      refusals({ ...entry, name: "action egress" }, cases, "0.0.65"),
    ).toEqual([
      'egress.test.ts "action egress" names a describe block. Name one case exactly.',
    ]);
  });

  it("a pattern is refused", () => {
    expect(
      refusals({ ...entry, name: "action egress > *" }, cases, "0.0.65"),
    ).toContain(
      'egress.test.ts "action egress > *" is a pattern. Name one case exactly.',
    );
  });

  it("an entry for another convex-test version is refused", () => {
    expect(refusals(entry, cases, "0.0.66")).toEqual([
      'egress.test.ts "action egress > a raw fetch dies" was checked against convex-test 0.0.65, but 0.0.66 is installed. Re-check it and update its version.',
    ]);
  });

  it("an entry with no binary behaviour, owner or evidence is refused", () => {
    expect(
      refusals(
        { ...entry, binary: "", owner: " ", evidence: "" },
        cases,
        "0.0.65",
      ),
    ).toEqual([
      'egress.test.ts "action egress > a raw fetch dies" has no binary.',
      'egress.test.ts "action egress > a raw fetch dies" has no owner.',
      'egress.test.ts "action egress > a raw fetch dies" has no evidence.',
    ]);
  });

  it("an entry that expects no outcomes is refused", () => {
    expect(refusals({ ...entry, outcomes: [] }, cases, "0.0.65")).toEqual([
      'egress.test.ts "action egress > a raw fetch dies" expects no outcomes. Name each function it calls.',
    ]);
  });

  it("an entry without its departure assertion's message is refused", () => {
    expect(refusals({ ...entry, departure: " " }, cases, "0.0.65")).toEqual([
      'egress.test.ts "action egress > a raw fetch dies" has no departure.',
    ]);
  });

  it("an entry that names no case is refused", () => {
    expect(
      refusals({ ...entry, name: "action egress > gone" }, cases, "0.0.65"),
    ).toEqual([
      'egress.test.ts "action egress > gone" names no case the file has.',
    ]);
  });

  it("the lane holds three exceptions: the action egress departure and the two route errors convex-test rejects", () => {
    expect(Arr.map(exceptions, ({ file, name }) => ({ file, name }))).toEqual([
      {
        file: "egress.test.ts",
        name: "action egress > a raw fetch in an action or a Node action dies with UndeclaredFetch naming the action and host",
      },
      {
        file: "httpRouteError.test.ts",
        name: "HTTP route errors > a root route that throws an Error answers the binary's 500 JSON error body",
      },
      {
        file: "httpRouteConvexError.test.ts",
        name: "HTTP route errors > a root route that throws a ConvexError answers the binary's 500 JSON error body with its data",
      },
    ]);
  });
});
