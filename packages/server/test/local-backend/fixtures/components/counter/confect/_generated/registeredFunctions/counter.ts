import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema";
import groupLayer from "../../counter.impl";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../counter.spec")["default"]>(databaseSchema, groupLayer);

export default {
["create"]: RegisteredConvexFunction.register({ ...definitions["create"], handler: forward(definitions["create"].handler) }),
["createInternal"]: RegisteredConvexFunction.register({ ...definitions["createInternal"], handler: forward(definitions["createInternal"].handler) }),
["list"]: RegisteredConvexFunction.register({ ...definitions["list"], handler: forward(definitions["list"].handler) }),
["reject"]: RegisteredConvexFunction.register({ ...definitions["reject"], handler: forward(definitions["reject"].handler) }),
["schedule"]: RegisteredConvexFunction.register({ ...definitions["schedule"], handler: forward(definitions["schedule"].handler) }),
["scheduleAndCancel"]: RegisteredConvexFunction.register({ ...definitions["scheduleAndCancel"], handler: forward(definitions["scheduleAndCancel"].handler) }),
["cancel"]: RegisteredConvexFunction.register({ ...definitions["cancel"], handler: forward(definitions["cancel"].handler) }),
["uploadUrl"]: RegisteredConvexFunction.register({ ...definitions["uploadUrl"], handler: forward(definitions["uploadUrl"].handler) }),
["storageUrl"]: RegisteredConvexFunction.register({ ...definitions["storageUrl"], handler: forward(definitions["storageUrl"].handler) }),
["hasAuth"]: RegisteredConvexFunction.register({ ...definitions["hasAuth"], handler: forward(definitions["hasAuth"].handler) }),
["location"]: RegisteredConvexFunction.register({ ...definitions["location"], handler: forward(definitions["location"].handler) }),
["page"]: RegisteredConvexFunction.register({ ...definitions["page"], handler: forward(definitions["page"].handler) }),
["environment"]: RegisteredConvexFunction.register({ ...definitions["environment"], handler: forward(definitions["environment"].handler) }),
["tick"]: RegisteredConvexFunction.register({ ...definitions["tick"], handler: forward(definitions["tick"].handler) }),
["ticks"]: RegisteredConvexFunction.register({ ...definitions["ticks"], handler: forward(definitions["ticks"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../counter.spec")["default"]>;
