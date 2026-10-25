import { RegisteredFunctions } from "@confect/server";
import { GroupImpl } from "@confect/server";
import databaseSchema from "../../schema.js";
import groupLayer from "../../../groups/nativeComponents.impl.js";

export default RegisteredFunctions.buildForGroup<typeof import("../../../groups/nativeComponents.spec.js")["default"]>(databaseSchema, groupLayer.pipe(GroupImpl.finalize({ required: [] })));
