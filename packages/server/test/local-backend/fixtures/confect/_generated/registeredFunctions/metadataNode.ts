import { RegisteredNodeFunction } from "@confect/server/node";
import databaseSchema from "../schema.js";
import groupLayer from "../../metadataNode.impl.js";

export default RegisteredNodeFunction.buildForGroup<typeof import("../../metadataNode.spec.js")["default"]>(databaseSchema, groupLayer);
