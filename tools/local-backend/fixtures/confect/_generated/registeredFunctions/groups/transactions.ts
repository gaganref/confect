import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Layer from "effect/Layer";
import observability from "../../../runtime.js";
import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/transactions.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/transactions.spec.js")["default"]>(databaseSchema, groupLayer.pipe(Layer.merge(Layer.succeed(RegisteredFunction.Observability, observability))));

export default {
["read"]: RegisteredConvexFunction.register({ ...definitions["read"], handler: forward(definitions["read"].handler) }),
["write"]: RegisteredConvexFunction.register({ ...definitions["write"], handler: forward(definitions["write"].handler) }),
["seed"]: RegisteredConvexFunction.register({ ...definitions["seed"], handler: forward(definitions["seed"].handler) }),
["limitedRead"]: RegisteredConvexFunction.register({ ...definitions["limitedRead"], handler: forward(definitions["limitedRead"].handler) }),
["limitedReadFromMutation"]: RegisteredConvexFunction.register({ ...definitions["limitedReadFromMutation"], handler: forward(definitions["limitedReadFromMutation"].handler) }),
["limitedWrite"]: RegisteredConvexFunction.register({ ...definitions["limitedWrite"], handler: forward(definitions["limitedWrite"].handler) }),
["rollback"]: RegisteredConvexFunction.register({ ...definitions["rollback"], handler: forward(definitions["rollback"].handler) }),
["staleRead"]: RegisteredConvexFunction.register({ ...definitions["staleRead"], handler: forward(definitions["staleRead"].handler) }),
["insertedIntervals"]: RegisteredConvexFunction.register({ ...definitions["insertedIntervals"], handler: forward(definitions["insertedIntervals"].handler) }),
["idle"]: RegisteredConvexFunction.register({ ...definitions["idle"], handler: forward(definitions["idle"].handler) }),
["readMetrics"]: RegisteredConvexFunction.register({ ...definitions["readMetrics"], handler: forward(definitions["readMetrics"].handler) }),
["staleMetrics"]: RegisteredConvexFunction.register({ ...definitions["staleMetrics"], handler: forward(definitions["staleMetrics"].handler) }),
["metrics"]: RegisteredConvexFunction.register({ ...definitions["metrics"], handler: forward(definitions["metrics"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/transactions.spec.js")["default"]>;
