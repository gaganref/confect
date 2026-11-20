import { Component } from "@confect/core";
import { QueryRunner } from "@confect/server";
import * as Effect from "effect/Effect";
import contract from "./confect/_generated/component";
import type spec from "./confect/_generated/spec";

const client = (native: Component.Api<typeof spec>) => {
  const { probe } = Component.bind(contract, native);
  const read = (ref: typeof probe.version) =>
    Effect.gen(function* () {
      const runner = yield* QueryRunner.QueryRunner;
      return yield* runner.runQuery(ref, {}).pipe(Effect.orDie);
    });
  return {
    version: () => read(probe.version),
    checkRuns: () => read(probe.checkRuns),
  };
};

export default Component.make("guarded", { env: {}, client });
