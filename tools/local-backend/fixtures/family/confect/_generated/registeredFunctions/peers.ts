import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../peers.impl.js";

const forward = <Ctx, Args extends ReadonlyArray<unknown>, Returns>(handler: (ctx: Ctx, ...args: Args) => Promise<Returns>) => (ctx: Ctx, ...args: Args) => handler(ctx, ...args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../peers.spec.js")["default"]>(databaseSchema, groupLayer);

export default {
["read"]: RegisteredConvexFunction.register({ ...definitions["read"], handler: forward(definitions["read"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../peers.spec.js")["default"]>;
