import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../viewer.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../viewer.spec.js")["default"]>(databaseSchema, groupLayer);

export default {
["whoAmI"]: RegisteredConvexFunction.register({ ...definitions["whoAmI"], handler: forward(definitions["whoAmI"].handler) }),
["postNote"]: RegisteredConvexFunction.register({ ...definitions["postNote"], handler: forward(definitions["postNote"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../viewer.spec.js")["default"]>;
