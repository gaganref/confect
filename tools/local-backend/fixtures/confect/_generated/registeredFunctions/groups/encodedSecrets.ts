import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/encodedSecrets.impl.js";

const forward = <Ctx, Args extends ReadonlyArray<unknown>, Returns>(handler: (ctx: Ctx, ...args: Args) => Promise<Returns>) => (ctx: Ctx, ...args: Args) => handler(ctx, ...args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/encodedSecrets.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["releasedTake"]: RegisteredConvexFunction.register({ ...definitions["releasedTake"], handler: forward(definitions["releasedTake"].handler) }),
["releasedGive"]: RegisteredConvexFunction.register({ ...definitions["releasedGive"], handler: forward(definitions["releasedGive"].handler) }),
["structTake"]: RegisteredConvexFunction.register({ ...definitions["structTake"], handler: forward(definitions["structTake"].handler) }),
["structGive"]: RegisteredConvexFunction.register({ ...definitions["structGive"], handler: forward(definitions["structGive"].handler) }),
["midChainTake"]: RegisteredConvexFunction.register({ ...definitions["midChainTake"], handler: forward(definitions["midChainTake"].handler) }),
["midChainGive"]: RegisteredConvexFunction.register({ ...definitions["midChainGive"], handler: forward(definitions["midChainGive"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/encodedSecrets.spec.js")["default"]>;
