// The kernel lane's `convex-test`: the test kernel's shim, with each backend
// opened under a world of its own seeded 0, as `TestConfect.layer` opens its
// kernel backend by default. A function with no bound invocation draws from
// that world's stream, where the kernel with no world refuses the draw, and a
// cron job's clock-schedule delay draws from it too. Imported by relative path,
// as in `TestConfect.ts`.
import type { GenericSchema, SchemaDefinition } from "convex/server";
import * as ConvexTest from "../../../test/src/internal/ConvexTest";
import * as DriverWorld from "../../../test/src/internal/DriverWorld";

export * from "../../../test/src/internal/ConvexTest";

/**
 * The seed every kernel-lane backend's world starts from, `TestConfect.layer`'s
 * default.
 */
export const laneSeed = 0;

type Options = Exclude<
  Parameters<typeof ConvexTest.convexTest>[0],
  SchemaDefinition<GenericSchema, boolean> | undefined
>;

/**
 * Whether `value` is the kernel's options object rather than a schema, as
 * `TestConfect.layer`'s convex-test target passes one with its own world.
 */
const isOptions = (value: unknown): value is Options =>
  typeof value === "object" &&
  value !== null &&
  !("tables" in value) &&
  ("modules" in value || "schema" in value || "world" in value);

/**
 * Convex-test's `convexTest(schema, modules)`, or the kernel's options form, on
 * the test kernel with a seeded world of its own unless the caller gave one.
 */
export function convexTest(
  schemaOrOptions?: SchemaDefinition<GenericSchema, boolean> | Options,
  modules?: Record<string, () => Promise<any>>,
): any {
  const world = DriverWorld.make("kernel lane", laneSeed);
  if (isOptions(schemaOrOptions)) {
    return ConvexTest.convexTest({ world, ...schemaOrOptions });
  }
  return ConvexTest.convexTest({
    ...(schemaOrOptions === undefined ? {} : { schema: schemaOrOptions }),
    ...(modules === undefined ? {} : { modules }),
    world,
  });
}
