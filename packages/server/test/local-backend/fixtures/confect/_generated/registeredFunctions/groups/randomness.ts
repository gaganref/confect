import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/randomness.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/randomness.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["query"]: RegisteredConvexFunction.register({ ...definitions["query"], handler: forward(definitions["query"].handler) }),
["mutation"]: RegisteredConvexFunction.register({ ...definitions["mutation"], handler: forward(definitions["mutation"].handler) }),
["action"]: RegisteredConvexFunction.register({ ...definitions["action"], handler: forward(definitions["action"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/randomness.spec.js")["default"]>;
