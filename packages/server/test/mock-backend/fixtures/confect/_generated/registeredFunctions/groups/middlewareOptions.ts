import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/middlewareOptions.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/middlewareOptions.spec.js")["default"]>(databaseSchema, groupLayer);

export default {
["shortName"]: RegisteredConvexFunction.register({ ...definitions["shortName"], handler: forward(definitions["shortName"].handler) }),
["longName"]: RegisteredConvexFunction.register({ ...definitions["longName"], handler: forward(definitions["longName"].handler) }),
["mutation"]: RegisteredConvexFunction.register({ ...definitions["mutation"], handler: forward(definitions["mutation"].handler) }),
["action"]: RegisteredConvexFunction.register({ ...definitions["action"], handler: forward(definitions["action"].handler) }),
["profiledQuery"]: RegisteredConvexFunction.register({ ...definitions["profiledQuery"], handler: forward(definitions["profiledQuery"].handler) }),
["profiledMutation"]: RegisteredConvexFunction.register({ ...definitions["profiledMutation"], handler: forward(definitions["profiledMutation"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/middlewareOptions.spec.js")["default"]>;
