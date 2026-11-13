import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../counter.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../counter.spec.js")["default"]>(databaseSchema, groupLayer);

export default {
["increment"]: RegisteredConvexFunction.register({ ...definitions["increment"], handler: forward(definitions["increment"].handler) }),
["notify"]: RegisteredConvexFunction.register({ ...definitions["notify"], handler: forward(definitions["notify"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../counter.spec.js")["default"]>;
