import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema";
import groupLayer from "../../../groups/components.impl";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/components.spec")["default"]>(databaseSchema, groupLayer);

export default {
["exercise"]: RegisteredConvexFunction.register({ ...definitions["exercise"], handler: forward(definitions["exercise"].handler) }),
["schedule"]: RegisteredConvexFunction.register({ ...definitions["schedule"], handler: forward(definitions["schedule"].handler) }),
["scheduleAndCancel"]: RegisteredConvexFunction.register({ ...definitions["scheduleAndCancel"], handler: forward(definitions["scheduleAndCancel"].handler) }),
["cancel"]: RegisteredConvexFunction.register({ ...definitions["cancel"], handler: forward(definitions["cancel"].handler) }),
["list"]: RegisteredConvexFunction.register({ ...definitions["list"], handler: forward(definitions["list"].handler) }),
["uploadUrl"]: RegisteredConvexFunction.register({ ...definitions["uploadUrl"], handler: forward(definitions["uploadUrl"].handler) }),
["storageUrl"]: RegisteredConvexFunction.register({ ...definitions["storageUrl"], handler: forward(definitions["storageUrl"].handler) }),
["hasAuth"]: RegisteredConvexFunction.register({ ...definitions["hasAuth"], handler: forward(definitions["hasAuth"].handler) }),
["deepCreate"]: RegisteredConvexFunction.register({ ...definitions["deepCreate"], handler: forward(definitions["deepCreate"].handler) }),
["deepRead"]: RegisteredConvexFunction.register({ ...definitions["deepRead"], handler: forward(definitions["deepRead"].handler) }),
["declaredError"]: RegisteredConvexFunction.register({ ...definitions["declaredError"], handler: forward(definitions["declaredError"].handler) }),
["seed"]: RegisteredConvexFunction.register({ ...definitions["seed"], handler: forward(definitions["seed"].handler) }),
["page"]: RegisteredConvexFunction.register({ ...definitions["page"], handler: forward(definitions["page"].handler) }),
["environment"]: RegisteredConvexFunction.register({ ...definitions["environment"], handler: forward(definitions["environment"].handler) }),
["ticks"]: RegisteredConvexFunction.register({ ...definitions["ticks"], handler: forward(definitions["ticks"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/components.spec")["default"]>;
