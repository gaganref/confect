import { MiddlewareSpec } from "@confect/core";
export class Policy extends MiddlewareSpec.MiddlewareSpec<Policy>()("Policy", { functionTypes: { query: true, mutation: true, action: true } }) {}