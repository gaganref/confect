import { Component } from "@confect/core";
import { MutationRunner, QueryRunner } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import contract from "./confect/_generated/component";
import type spec from "./confect/_generated/spec";

const client = (native: Component.Api<typeof spec>) => {
  const { counter } = Component.bind(contract, native);
  return {
    create: Effect.fn("Counter.create")(function* (run: string, count: number) {
      const runner = yield* MutationRunner.MutationRunner;
      yield* runner
        .runMutation(counter.create, { run, count })
        .pipe(Effect.orDie);
    }),
    counts: Effect.fn("Counter.counts")(function* (run: string) {
      const runner = yield* QueryRunner.QueryRunner;
      const docs = yield* runner
        .runQuery(counter.list, { run })
        .pipe(Effect.orDie);
      return docs.map((doc) => doc.count);
    }),
  };
};

export default Component.make("counter", {
  env: {
    COMPONENT_REQUIRED: Schema.String,
    COMPONENT_OPTIONAL: Schema.optionalKey(Schema.String),
    COMPONENT_MARKER: Schema.optionalKey(Schema.String),
    COMPONENT_UNBOUND: Schema.optionalKey(Schema.String),
  },
  client,
});
