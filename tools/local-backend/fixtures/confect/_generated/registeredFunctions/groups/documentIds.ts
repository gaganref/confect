import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/documentIds.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/documentIds.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["nativeSampleId"]: RegisteredConvexFunction.register({ ...definitions["nativeSampleId"], handler: forward(definitions["nativeSampleId"].handler) }),
["inspect"]: RegisteredConvexFunction.register({ ...definitions["inspect"], handler: forward(definitions["inspect"].handler) }),
["inspectFromMutation"]: RegisteredConvexFunction.register({ ...definitions["inspectFromMutation"], handler: forward(definitions["inspectFromMutation"].handler) }),
["createAndDelete"]: RegisteredConvexFunction.register({ ...definitions["createAndDelete"], handler: forward(definitions["createAndDelete"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/documentIds.spec.js")["default"]>;
