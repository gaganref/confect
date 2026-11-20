import { RegisteredNodeFunction } from "@confect/server/node";
import databaseSchema from "../schema.js";
import groupLayer from "../../probeNode.impl.js";

export default RegisteredNodeFunction.buildForGroup<typeof import("../../probeNode.spec.js")["default"]>(databaseSchema, groupLayer);
