import { Ref } from "@confect/core";
import * as Context from "effect/Context";
import * as Rec from "effect/Record";
import testing from "../../../../tools/local-backend/fixtures/confect/_generated/testing";
import * as Clock from "../../src/internal/Clock";
import { convexTest, type KernelControls } from "../../src/internal/ConvexTest";
import type * as Invocation from "../../src/internal/Invocation";

/**
 * The world each backend here is given, as `TestConfect.layer` gives its own:
 * no services, the host's clock and a fixed stream. Some fixture modules draw
 * while they load, which the kernel draws from this stream when no invocation
 * is bound.
 */
const ownWorld = (): Invocation.World => {
  let state = 1;
  return {
    name: "localBackendWorld",
    services: Context.empty(),
    clock: Clock.hostNow,
    random: () => {
      state = (state * 48_271) % 2_147_483_647;
      return state / 2_147_483_647;
    },
  };
};

/**
 * The local-backend fixture's app, every component mounted as on the binary, on
 * a fresh test kernel. A probe calls the same registered functions here as the
 * binary lane calls over HTTP.
 */
export const localBackendWorld = (): KernelControls => {
  const t = convexTest({
    schema: testing.convexSchema,
    modules: testing.modules,
    world: ownWorld(),
  });
  for (const [name, kit] of Rec.toEntries(testing.components)) {
    t.registerComponent(name, kit.schema, kit.modules);
  }
  return t;
};

type Kind = "query" | "mutation" | "action";

/**
 * Call a fixture ref through `accessor`, encoding its arguments and decoding
 * its result with the ref's codecs.
 */
export const call = <R extends Ref.Any>(
  accessor: KernelControls,
  kind: Kind,
  ref: R,
  ...args: Ref.OptionalArgs<R>
) =>
  Ref.runWithCodec(ref, (args[0] ?? {}) as Ref.Args<R>, (reference, encoded) =>
    accessor[kind](reference, encoded),
  );
