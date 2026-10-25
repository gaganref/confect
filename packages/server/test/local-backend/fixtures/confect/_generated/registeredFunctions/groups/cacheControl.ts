import { RegisteredFunctions } from "@confect/server";
import { GroupImpl } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/cacheControl.impl.js";

export default RegisteredFunctions.buildForGroup<typeof import("../../../groups/cacheControl.spec.js")["default"]>(databaseSchema, groupLayer.pipe(GroupImpl.finalize({ required: [] })));
