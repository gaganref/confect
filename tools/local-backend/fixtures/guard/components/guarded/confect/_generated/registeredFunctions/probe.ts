import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../probe.impl.js";

const forward = <Ctx, Args extends ReadonlyArray<unknown>, Returns>(handler: (ctx: Ctx, ...args: Args) => Promise<Returns>) => (ctx: Ctx, ...args: Args) => handler(ctx, ...args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../probe.spec.js")["default"]>(databaseSchema, groupLayer);

export default {
["version"]: RegisteredConvexFunction.register({ ...definitions["version"], handler: forward(definitions["version"].handler) }),
["checkRuns"]: RegisteredConvexFunction.register({ ...definitions["checkRuns"], handler: forward(definitions["checkRuns"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../probe.spec.js")["default"]>;
