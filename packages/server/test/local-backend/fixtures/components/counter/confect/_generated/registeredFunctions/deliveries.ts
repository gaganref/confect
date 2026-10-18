import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema";
import groupLayer from "../../deliveries.impl";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../deliveries.spec")["default"]>(databaseSchema, groupLayer);

export default {
["send"]: RegisteredConvexFunction.register({ ...definitions["send"], handler: forward(definitions["send"].handler) }),
["deliver"]: RegisteredConvexFunction.register({ ...definitions["deliver"], handler: forward(definitions["deliver"].handler) }),
["setStatus"]: RegisteredConvexFunction.register({ ...definitions["setStatus"], handler: forward(definitions["setStatus"].handler) }),
["breach"]: RegisteredConvexFunction.register({ ...definitions["breach"], handler: forward(definitions["breach"].handler) }),
["get"]: RegisteredConvexFunction.register({ ...definitions["get"], handler: forward(definitions["get"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../deliveries.spec")["default"]>;
