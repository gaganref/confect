import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/metadata.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/metadata.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["queryMetadata"]: RegisteredConvexFunction.register({ ...definitions["queryMetadata"], handler: forward(definitions["queryMetadata"].handler) }),
["mutationMetadata"]: RegisteredConvexFunction.register({ ...definitions["mutationMetadata"], handler: forward(definitions["mutationMetadata"].handler) }),
["snapshotMutation"]: RegisteredConvexFunction.register({ ...definitions["snapshotMutation"], handler: forward(definitions["snapshotMutation"].handler) }),
["actionMetadata"]: RegisteredConvexFunction.register({ ...definitions["actionMetadata"], handler: forward(definitions["actionMetadata"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/metadata.spec.js")["default"]>;
