import { RegisteredNodeFunction } from "@confect/server/node";
import databaseSchema from "../schema.js";
import groupLayer from "../../egressNode.impl.js";

export default RegisteredNodeFunction.buildForGroup<typeof import("../../egressNode.spec.js")["default"]>(databaseSchema, groupLayer);
