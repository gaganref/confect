// A module only one case in `IoBans.test.ts` loads, so the kernel's load of it
// is Vitest's first fetch of the file, which Vitest wraps in `withSafeTimers`.
import { queryGeneric } from "convex/server";

export const query = queryGeneric({
  args: {},
  handler: () => Promise.resolve("loaded"),
});
