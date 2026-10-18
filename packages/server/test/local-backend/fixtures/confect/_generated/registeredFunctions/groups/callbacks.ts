import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import databaseSchema from "../../schema";
import groupLayer from "../../../groups/callbacks.impl";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../../groups/callbacks.spec")["default"]>(databaseSchema, groupLayer);

export default {
["onEvent"]: RegisteredConvexFunction.register({ ...definitions["onEvent"], handler: forward(definitions["onEvent"].handler) }),
["send"]: RegisteredConvexFunction.register({ ...definitions["send"], handler: forward(definitions["send"].handler) }),
["setStatus"]: RegisteredConvexFunction.register({ ...definitions["setStatus"], handler: forward(definitions["setStatus"].handler) }),
["breach"]: RegisteredConvexFunction.register({ ...definitions["breach"], handler: forward(definitions["breach"].handler) }),
["sameHandle"]: RegisteredConvexFunction.register({ ...definitions["sameHandle"], handler: forward(definitions["sameHandle"].handler) }),
["createRetired"]: RegisteredConvexFunction.register({ ...definitions["createRetired"], handler: forward(definitions["createRetired"].handler) }),
["createMismatched"]: RegisteredConvexFunction.register({ ...definitions["createMismatched"], handler: forward(definitions["createMismatched"].handler) }),
["get"]: RegisteredConvexFunction.register({ ...definitions["get"], handler: forward(definitions["get"].handler) }),
["events"]: RegisteredConvexFunction.register({ ...definitions["events"], handler: forward(definitions["events"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../../groups/callbacks.spec")["default"]>;
