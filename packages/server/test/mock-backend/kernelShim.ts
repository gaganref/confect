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

/**
 * Convex-test's `convexTest(schema, modules)`, on the test kernel with a seeded
 * world of its own.
 */
export function convexTest(
  schema?: SchemaDefinition<GenericSchema, boolean>,
  modules?: Record<string, () => Promise<any>>,
): any {
  return ConvexTest.convexTest({
    ...(schema === undefined ? {} : { schema }),
    ...(modules === undefined ? {} : { modules }),
    world: DriverWorld.make("kernel lane", laneSeed),
  });
}
