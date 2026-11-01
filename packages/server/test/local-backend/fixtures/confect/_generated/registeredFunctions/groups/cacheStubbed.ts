import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/cacheStubbed.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/cacheStubbed.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["confectNoTime"]: RegisteredConvexFunction.register({ ...definitions["confectNoTime"], handler: forward(definitions["confectNoTime"].handler) }),
["confectWithClock"]: RegisteredConvexFunction.register({ ...definitions["confectWithClock"], handler: forward(definitions["confectWithClock"].handler) }),
["confectWithRawDateNow"]: RegisteredConvexFunction.register({ ...definitions["confectWithRawDateNow"], handler: forward(definitions["confectWithRawDateNow"].handler) }),
["confectWithSpan"]: RegisteredConvexFunction.register({ ...definitions["confectWithSpan"], handler: forward(definitions["confectWithSpan"].handler) }),
["confectWithLog"]: RegisteredConvexFunction.register({ ...definitions["confectWithLog"], handler: forward(definitions["confectWithLog"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/cacheStubbed.spec.js")["default"]>;
