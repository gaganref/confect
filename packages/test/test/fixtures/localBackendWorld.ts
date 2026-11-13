import { Ref } from "@confect/core";
import testing from "../../../../tools/local-backend/fixtures/confect/_generated/testing";
import { convexTest, type KernelControls } from "../../src/internal/ConvexTest";

/**
 * The local-backend fixture's app, every component mounted as on the binary, on
 * a fresh test kernel. A probe calls the same registered functions here as the
 * binary lane calls over HTTP.
 */
export const localBackendWorld = (): KernelControls => {
  const t = convexTest(testing.convexSchema, testing.modules);
  for (const [name, kit] of Object.entries(testing.components)) {
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
