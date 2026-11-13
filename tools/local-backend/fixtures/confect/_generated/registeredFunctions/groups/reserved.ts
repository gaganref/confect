import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/reserved.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/reserved.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["echo"]: RegisteredConvexFunction.register({ ...definitions["echo"], handler: forward(definitions["echo"].handler) }),
["echoAction"]: RegisteredConvexFunction.register({ ...definitions["echoAction"], handler: forward(definitions["echoAction"].handler) }),
["inline"]: RegisteredConvexFunction.register({ ...definitions["inline"], handler: forward(definitions["inline"].handler) }),
["write"]: RegisteredConvexFunction.register({ ...definitions["write"], handler: forward(definitions["write"].handler) }),
["read"]: RegisteredConvexFunction.register({ ...definitions["read"], handler: forward(definitions["read"].handler) }),
["chain"]: RegisteredConvexFunction.register({ ...definitions["chain"], handler: forward(definitions["chain"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/reserved.spec.js")["default"]>;
