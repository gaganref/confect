import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/mounts.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/mounts.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["create"]: RegisteredConvexFunction.register({ ...definitions["create"], handler: forward(definitions["create"].handler) }),
["counts"]: RegisteredConvexFunction.register({ ...definitions["counts"], handler: forward(definitions["counts"].handler) }),
["replaced"]: RegisteredConvexFunction.register({ ...definitions["replaced"], handler: forward(definitions["replaced"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/mounts.spec.js")["default"]>;
