import { RegisteredNodeFunction } from "@confect/server/node";
import databaseSchema from "../schema.js";
import groupLayer from "../../typedErrorsNode.impl.js";

export default RegisteredNodeFunction.buildForGroup<typeof import("../../typedErrorsNode.spec.js")["default"]>(databaseSchema, groupLayer);
