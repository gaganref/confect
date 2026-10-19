import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../env.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../env.spec.js")["default"]>(databaseSchema, groupLayer);

export default {
["readEnvVar"]: RegisteredConvexFunction.register({ ...definitions["readEnvVar"], handler: forward(definitions["readEnvVar"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../env.spec.js")["default"]>;
