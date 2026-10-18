import type { Ref } from "@confect/core";
import { QueryRunner } from "@confect/server";
import * as Effect from "effect/Effect";
import type refs from "./_generated/refs";
import type { ClassProbe } from "./authoring.spec";

export const classProbeHandler = (
  ref: Ref.Callable<typeof refs.public.authoring.probe>,
  value: string,
) =>
  Effect.gen(function* () {
    const runner = yield* QueryRunner.QueryRunner;
    const probe: ClassProbe = yield* runner.runQuery(ref, { value });
    return probe.render();
  }).pipe(Effect.orDie);
