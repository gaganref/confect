import { RegisteredNodeFunction } from "@confect/server/node";
import { GroupImpl } from "@confect/server";
import databaseSchema from "../schema.js";
import groupLayer from "../../metadataNode.impl.js";

export default RegisteredNodeFunction.buildForGroup<typeof import("../../metadataNode.spec.js")["default"]>(databaseSchema, groupLayer.pipe(GroupImpl.finalize({ required: [] })));
