import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as PushCheck from "@confect/server/PushCheck";
import { Preflight } from "@confect/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Provenance from "../src/internal/Provenance";
import * as PushPreflight from "../src/internal/PushPreflight";

/**
 * A module loader whose module registers a check named `name` for `schema` as
 * it loads.
 */
const registering = (schema: object, name: string) => () => {
  PushCheck.register(
    schema,
    PushCheck.make(name, () => []),
  );
  return Promise.resolve({ read: name });
};

describe("record", () => {
  it.effect(
    "keeps a registration on the namespace of the load it ran in, for the target that owns that load",
    () =>
      Effect.gen(function* () {
        const owner = { componentPath: "child" };
        const schema = DatabaseSchema.make({});
        const namespace = yield* Effect.promise(() =>
          Provenance.owning(owner, () =>
            Provenance.record(registering(schema, "owned")),
          ),
        );
        expect(Provenance.schemasOf([namespace])).toEqual([schema]);
        expect(Provenance.unattributedOf(owner)).toEqual([]);
      }),
  );

  it.effect(
    "keeps a registration made while one target's load runs inside another's for neither, so the build refuses with PushCheckUnattributed naming the check",
    () =>
      Effect.gen(function* () {
        const host = { componentPath: "" };
        const child = { componentPath: "child" };
        const schema = DatabaseSchema.make({});
        const namespace = yield* Effect.promise(() =>
          Provenance.owning(host, () =>
            Provenance.record(() =>
              Provenance.owning(child, () =>
                Provenance.record(registering(schema, "tangled")),
              ),
            ),
          ),
        );
        expect(Provenance.schemasOf([namespace])).toEqual([]);
        expect(Provenance.unattributedOf(host)).toEqual([schema]);
        expect(Provenance.unattributedOf(child)).toEqual([schema]);
        const verdict = PushPreflight.verify([
          {
            modules: [namespace],
            unattributed: Provenance.unattributedOf(host),
          },
          {
            modules: [],
            componentPath: "child",
            unattributed: Provenance.unattributedOf(child),
          },
        ]);
        expect(verdict).toStrictEqual(
          Result.fail(
            Preflight.PushCheckUnattributed.make({ checks: ["tangled"] }),
          ),
        );
      }),
  );

  it("sees no registration made outside any load", () => {
    const owner = { componentPath: "child" };
    const schema = DatabaseSchema.make({});
    PushCheck.register(
      schema,
      PushCheck.make("outside", () => []),
    );
    expect(Provenance.schemasOf([{ read: "outside" }])).toEqual([]);
    expect(Provenance.unattributedOf(owner)).toEqual([]);
  });
});
