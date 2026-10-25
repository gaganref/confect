import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import { GroupImpl } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/scheduling.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/scheduling.spec.js")["default"]>(databaseSchema, groupLayer.pipe(GroupImpl.finalize({ required: [] })));

export default {
["manyOpsQuery"]: RegisteredConvexFunction.register({ ...definitions["manyOpsQuery"], handler: forward(definitions["manyOpsQuery"].handler) }),
["manyOpsMutation"]: RegisteredConvexFunction.register({ ...definitions["manyOpsMutation"], handler: forward(definitions["manyOpsMutation"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/scheduling.spec.js")["default"]>;
