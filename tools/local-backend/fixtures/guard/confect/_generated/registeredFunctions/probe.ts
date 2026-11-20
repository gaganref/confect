import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../probe.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../probe.spec.js")["default"]>(databaseSchema, groupLayer);

export default {
["version"]: RegisteredConvexFunction.register({ ...definitions["version"], handler: forward(definitions["version"].handler) }),
["checkRuns"]: RegisteredConvexFunction.register({ ...definitions["checkRuns"], handler: forward(definitions["checkRuns"].handler) }),
["internalRuns"]: RegisteredConvexFunction.register({ ...definitions["internalRuns"], handler: forward(definitions["internalRuns"].handler) }),
["touch"]: RegisteredConvexFunction.register({ ...definitions["touch"], handler: forward(definitions["touch"].handler) }),
["internalTouch"]: RegisteredConvexFunction.register({ ...definitions["internalTouch"], handler: forward(definitions["internalTouch"].handler) }),
["act"]: RegisteredConvexFunction.register({ ...definitions["act"], handler: forward(definitions["act"].handler) }),
["internalAct"]: RegisteredConvexFunction.register({ ...definitions["internalAct"], handler: forward(definitions["internalAct"].handler) }),
["componentVersion"]: RegisteredConvexFunction.register({ ...definitions["componentVersion"], handler: forward(definitions["componentVersion"].handler) }),
["componentCheckRuns"]: RegisteredConvexFunction.register({ ...definitions["componentCheckRuns"], handler: forward(definitions["componentCheckRuns"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../probe.spec.js")["default"]>;
