import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";
import { GroupImpl } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../databaseReader.impl.js";

const forward = <Ctx, Args, Returns>(handler: (ctx: Ctx, args: Args) => Promise<Returns>) => (ctx: Ctx, args: Args) => handler(ctx, args);

const definitions = ConvexFunctionDefinitions.buildForGroup<typeof import("../../databaseReader.spec.js")["default"]>(databaseSchema, groupLayer.pipe(GroupImpl.finalize({ required: [] })));

export default {
["getNote"]: RegisteredConvexFunction.register({ ...definitions["getNote"], handler: forward(definitions["getNote"].handler) }),
["listNotes"]: RegisteredConvexFunction.register({ ...definitions["listNotes"], handler: forward(definitions["listNotes"].handler) }),
["paginateNotes"]: RegisteredConvexFunction.register({ ...definitions["paginateNotes"], handler: forward(definitions["paginateNotes"].handler) }),
["paginateNotesWithFilter"]: RegisteredConvexFunction.register({ ...definitions["paginateNotesWithFilter"], handler: forward(definitions["paginateNotesWithFilter"].handler) }),
["paginateNotesOrFail"]: RegisteredConvexFunction.register({ ...definitions["paginateNotesOrFail"], handler: forward(definitions["paginateNotesOrFail"].handler) }),
} as RegisteredFunctions.RegisteredFunctionsForGroupSpec<typeof import("../../databaseReader.spec.js")["default"]>;
