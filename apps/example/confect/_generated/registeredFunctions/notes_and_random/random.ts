import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../notes_and_random/random.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../notes_and_random/random.spec.js")["default"]>(databaseSchema, groupLayer);

export default {
["getNumber"]: RegisteredConvexFunction.register({ ...definitions["getNumber"], handler: forward(definitions["getNumber"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../notes_and_random/random.spec.js")["default"]>;
