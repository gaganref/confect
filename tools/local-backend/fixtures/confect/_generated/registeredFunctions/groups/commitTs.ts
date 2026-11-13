import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/commitTs.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/commitTs.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["stamp"]: RegisteredConvexFunction.register({ ...definitions["stamp"], handler: forward(definitions["stamp"].handler) }),
["maxAfterPending"]: RegisteredConvexFunction.register({ ...definitions["maxAfterPending"], handler: forward(definitions["maxAfterPending"].handler) }),
["newestFirst"]: RegisteredConvexFunction.register({ ...definitions["newestFirst"], handler: forward(definitions["newestFirst"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/commitTs.spec.js")["default"]>;
