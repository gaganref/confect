import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/secretTwins.impl.js";

const forward = <Ctx, Args extends ReadonlyArray<unknown>, Returns>(handler: (ctx: Ctx, ...args: Args) => Promise<Returns>) => (ctx: Ctx, ...args: Args) => handler(ctx, ...args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/secretTwins.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["countPlain"]: RegisteredConvexFunction.register({ ...definitions["countPlain"], handler: forward(definitions["countPlain"].handler) }),
["countSecret"]: RegisteredConvexFunction.register({ ...definitions["countSecret"], handler: forward(definitions["countSecret"].handler) }),
["idPlain"]: RegisteredConvexFunction.register({ ...definitions["idPlain"], handler: forward(definitions["idPlain"].handler) }),
["idSecret"]: RegisteredConvexFunction.register({ ...definitions["idSecret"], handler: forward(definitions["idSecret"].handler) }),
["toStringPlain"]: RegisteredConvexFunction.register({ ...definitions["toStringPlain"], handler: forward(definitions["toStringPlain"].handler) }),
["toStringSecret"]: RegisteredConvexFunction.register({ ...definitions["toStringSecret"], handler: forward(definitions["toStringSecret"].handler) }),
["pendingPlain"]: RegisteredConvexFunction.register({ ...definitions["pendingPlain"], handler: forward(definitions["pendingPlain"].handler) }),
["pendingSecret"]: RegisteredConvexFunction.register({ ...definitions["pendingSecret"], handler: forward(definitions["pendingSecret"].handler) }),
["datePlain"]: RegisteredConvexFunction.register({ ...definitions["datePlain"], handler: forward(definitions["datePlain"].handler) }),
["dateSecret"]: RegisteredConvexFunction.register({ ...definitions["dateSecret"], handler: forward(definitions["dateSecret"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/secretTwins.spec.js")["default"]>;
