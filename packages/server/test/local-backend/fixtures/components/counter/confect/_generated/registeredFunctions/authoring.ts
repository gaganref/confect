import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../authoring.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../authoring.spec.js")["default"]>(databaseSchema, groupLayer);

export default {
["mint"]: RegisteredConvexFunction.register({ ...definitions["mint"], handler: forward(definitions["mint"].handler) }),
["save"]: RegisteredConvexFunction.register({ ...definitions["save"], handler: forward(definitions["save"].handler) }),
["read"]: RegisteredConvexFunction.register({ ...definitions["read"], handler: forward(definitions["read"].handler) }),
["probe"]: RegisteredConvexFunction.register({ ...definitions["probe"], handler: forward(definitions["probe"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../authoring.spec.js")["default"]>;
