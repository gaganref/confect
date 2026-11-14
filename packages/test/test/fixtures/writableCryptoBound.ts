// A `crypto` a test left non-configurable but writable, so the kernel installs
// its own in place, then three bound Confect handlers on the local-backend
// fixture: the randomness probe's query, a query that reads two Confect
// components, and a component's scheduled mutation the drain runs. Each runs
// through the invocation bridge's pin. Printed as bytes. A non-configurable
// global cannot be undone in a process, so `Randomness.test.ts` runs this in a
// process of its own.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import refs from "../../../../tools/local-backend/fixtures/confect/_generated/refs";
import * as Invocation from "../../src/internal/Invocation";
import { invocationOf, streamFor } from "./drawingBackend";
import { call, localBackendWorld } from "./localBackendWorld";
import { normalize } from "./randomnessProbe";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

Object.defineProperty(globalThis, "crypto", {
  value: globalThis.crypto,
  writable: true,
  configurable: false,
});

const settle = <A>(run: () => Promise<A>) =>
  Effect.promise(() =>
    run().then(
      (value) => ({ outcome: "ran" as const, value }),
      (error: unknown) => ({
        outcome: "refused" as const,
        message: error instanceof Error ? error.message : "a non-Error",
      }),
    ),
  );

const components = refs.public.groups.components;

const run = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const t = localBackendWorld();
  const bound = <A, E>(effect: Effect.Effect<A, E>) =>
    settle(() =>
      Invocation.bind(invocationOf(streamFor(600)), () =>
        Effect.runPromiseWith(context)(effect),
      ),
    );
  const confect = yield* bound(
    call(t, "query", refs.public.groups.randomness.query),
  );
  const component = yield* bound(
    call(t, "query", components.list, { run: "bound" }),
  );
  const scheduled = yield* bound(
    call(t, "mutation", components.schedule, { run: "bound" }).pipe(
      Effect.andThen(
        Effect.promise(() => t.finishAllScheduledFunctions(() => {})),
      ),
      Effect.andThen(call(t, "query", components.list, { run: "bound" })),
    ),
  );
  const output = yield* Schema.encodeEffect(UnknownJson)({
    confect:
      confect.outcome === "ran"
        ? { outcome: "ran", value: normalize(confect.value) }
        : confect,
    component,
    scheduled,
  });
  process.stdout.write(output);
});

void Effect.runPromise(run);
