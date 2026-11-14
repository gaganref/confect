import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/ioBans.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/ioBans.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["fetchInQuery"]: RegisteredConvexFunction.register({ ...definitions["fetchInQuery"], handler: forward(definitions["fetchInQuery"].handler) }),
["fetchInMutation"]: RegisteredConvexFunction.register({ ...definitions["fetchInMutation"], handler: forward(definitions["fetchInMutation"].handler) }),
["timerInQuery"]: RegisteredConvexFunction.register({ ...definitions["timerInQuery"], handler: forward(definitions["timerInQuery"].handler) }),
["timerInMutation"]: RegisteredConvexFunction.register({ ...definitions["timerInMutation"], handler: forward(definitions["timerInMutation"].handler) }),
["awaitedTimerInQuery"]: RegisteredConvexFunction.register({ ...definitions["awaitedTimerInQuery"], handler: forward(definitions["awaitedTimerInQuery"].handler) }),
["awaitedTimerInMutation"]: RegisteredConvexFunction.register({ ...definitions["awaitedTimerInMutation"], handler: forward(definitions["awaitedTimerInMutation"].handler) }),
["surfaceInQuery"]: RegisteredConvexFunction.register({ ...definitions["surfaceInQuery"], handler: forward(definitions["surfaceInQuery"].handler) }),
["surfaceInAction"]: RegisteredConvexFunction.register({ ...definitions["surfaceInAction"], handler: forward(definitions["surfaceInAction"].handler) }),
["formDataInQuery"]: RegisteredConvexFunction.register({ ...definitions["formDataInQuery"], handler: forward(definitions["formDataInQuery"].handler) }),
["formDataInMutation"]: RegisteredConvexFunction.register({ ...definitions["formDataInMutation"], handler: forward(definitions["formDataInMutation"].handler) }),
["formDataInAction"]: RegisteredConvexFunction.register({ ...definitions["formDataInAction"], handler: forward(definitions["formDataInAction"].handler) }),
["clearInQuery"]: RegisteredConvexFunction.register({ ...definitions["clearInQuery"], handler: forward(definitions["clearInQuery"].handler) }),
["fetchInAction"]: RegisteredConvexFunction.register({ ...definitions["fetchInAction"], handler: forward(definitions["fetchInAction"].handler) }),
["timersInAction"]: RegisteredConvexFunction.register({ ...definitions["timersInAction"], handler: forward(definitions["timersInAction"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/ioBans.spec.js")["default"]>;
