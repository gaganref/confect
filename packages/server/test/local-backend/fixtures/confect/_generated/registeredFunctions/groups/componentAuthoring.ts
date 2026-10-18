import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema";
import groupLayer from "../../../groups/componentAuthoring.impl";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/componentAuthoring.spec")["default"]>(databaseSchema, groupLayer);

export default {
["save"]: RegisteredConvexFunction.register({ ...definitions["save"], handler: forward(definitions["save"].handler) }),
["read"]: RegisteredConvexFunction.register({ ...definitions["read"], handler: forward(definitions["read"].handler) }),
["probe"]: RegisteredConvexFunction.register({ ...definitions["probe"], handler: forward(definitions["probe"].handler) }),
["render"]: RegisteredConvexFunction.register({ ...definitions["render"], handler: forward(definitions["render"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/componentAuthoring.spec")["default"]>;
