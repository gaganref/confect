import { RegisteredNodeFunction } from "@confect/server/node";
import databaseSchema from "../schema.js";
import groupLayer from "../../email.impl.js";

export default RegisteredNodeFunction.buildForGroup<typeof import("../../email.spec.js")["default"]>(databaseSchema, groupLayer);
