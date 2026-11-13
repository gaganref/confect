import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/requests.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/requests.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["mutation"]: RegisteredConvexFunction.register({ ...definitions["mutation"], handler: forward(definitions["mutation"].handler) }),
["action"]: RegisteredConvexFunction.register({ ...definitions["action"], handler: forward(definitions["action"].handler) }),
["schedule"]: RegisteredConvexFunction.register({ ...definitions["schedule"], handler: forward(definitions["schedule"].handler) }),
["recorded"]: RegisteredConvexFunction.register({ ...definitions["recorded"], handler: forward(definitions["recorded"].handler) }),
["read"]: RegisteredConvexFunction.register({ ...definitions["read"], handler: forward(definitions["read"].handler) }),
["readAction"]: RegisteredConvexFunction.register({ ...definitions["readAction"], handler: forward(definitions["readAction"].handler) }),
["scheduledMutation"]: RegisteredConvexFunction.register({ ...definitions["scheduledMutation"], handler: forward(definitions["scheduledMutation"].handler) }),
["scheduledAction"]: RegisteredConvexFunction.register({ ...definitions["scheduledAction"], handler: forward(definitions["scheduledAction"].handler) }),
["record"]: RegisteredConvexFunction.register({ ...definitions["record"], handler: forward(definitions["record"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/requests.spec.js")["default"]>;
