import { pushCheck as pushCheck0 } from "../functions.js";
import * as PushCheck from "@confect/server/PushCheck";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../probe.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../probe.spec.js")["default"]>(databaseSchema, groupLayer);

export default PushCheck.guardFunctions({
["version"]: RegisteredConvexFunction.register({ ...definitions["version"], handler: forward(definitions["version"].handler) }),
["checkRuns"]: RegisteredConvexFunction.register({ ...definitions["checkRuns"], handler: forward(definitions["checkRuns"].handler) }),
}, [pushCheck0], "probe") as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../probe.spec.js")["default"]>;
