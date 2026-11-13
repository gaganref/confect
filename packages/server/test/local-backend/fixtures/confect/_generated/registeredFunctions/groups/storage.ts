import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/storage.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/storage.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["generateUploadUrl"]: RegisteredConvexFunction.register({ ...definitions["generateUploadUrl"], handler: forward(definitions["generateUploadUrl"].handler) }),
["getUrl"]: RegisteredConvexFunction.register({ ...definitions["getUrl"], handler: forward(definitions["getUrl"].handler) }),
["store"]: RegisteredConvexFunction.register({ ...definitions["store"], handler: forward(definitions["store"].handler) }),
["get"]: RegisteredConvexFunction.register({ ...definitions["get"], handler: forward(definitions["get"].handler) }),
["deleteBlob"]: RegisteredConvexFunction.register({ ...definitions["deleteBlob"], handler: forward(definitions["deleteBlob"].handler) }),
["storeWith"]: RegisteredConvexFunction.register({ ...definitions["storeWith"], handler: forward(definitions["storeWith"].handler) }),
["describe"]: RegisteredConvexFunction.register({ ...definitions["describe"], handler: forward(definitions["describe"].handler) }),
["deleteRaw"]: RegisteredConvexFunction.register({ ...definitions["deleteRaw"], handler: forward(definitions["deleteRaw"].handler) }),
["storeInMutation"]: RegisteredConvexFunction.register({ ...definitions["storeInMutation"], handler: forward(definitions["storeInMutation"].handler) }),
["storeAndRead"]: RegisteredConvexFunction.register({ ...definitions["storeAndRead"], handler: forward(definitions["storeAndRead"].handler) }),
["fileProbe"]: RegisteredConvexFunction.register({ ...definitions["fileProbe"], handler: forward(definitions["fileProbe"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/storage.spec.js")["default"]>;
