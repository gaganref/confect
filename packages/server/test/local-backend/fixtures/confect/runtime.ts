import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";

export const hops = new Map<string, string>();
export default Layer.succeed(RegisteredFunction.Forward, (span) => {
  hops.set(span.spanId, span.name);
  return { hop: span.spanId };
}) satisfies Layer.Layer<never>;
