import { RegisteredFunctions } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../workpool.impl.js";

export default RegisteredFunctions.buildForGroup<typeof import("../../workpool.spec.js")["default"]>(databaseSchema, groupLayer);
