import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../hello.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../hello.spec.js")["default"]>(databaseSchema, groupLayer);

export default {
["readMarker"]: RegisteredConvexFunction.register({ ...definitions["readMarker"], handler: forward(definitions["readMarker"].handler) }),
["greet"]: RegisteredConvexFunction.register({ ...definitions["greet"], handler: forward(definitions["greet"].handler) }),
["increment"]: RegisteredConvexFunction.register({ ...definitions["increment"], handler: forward(definitions["increment"].handler) }),
["onResult"]: RegisteredConvexFunction.register({ ...definitions["onResult"], handler: forward(definitions["onResult"].handler) }),
["wrongArgs"]: RegisteredConvexFunction.register({ ...definitions["wrongArgs"], handler: forward(definitions["wrongArgs"].handler) }),
["notify"]: RegisteredConvexFunction.register({ ...definitions["notify"], handler: forward(definitions["notify"].handler) }),
["checkArgs"]: RegisteredConvexFunction.register({ ...definitions["checkArgs"], handler: forward(definitions["checkArgs"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../hello.spec.js")["default"]>;
