import { RegisteredNodeFunction } from "@confect/server/node";
import databaseSchema from "../schema.js";
import groupLayer from "../../peersNodeTwo.impl.js";

export default RegisteredNodeFunction.buildForGroup<typeof import("../../peersNodeTwo.spec.js")["default"]>(databaseSchema, groupLayer);
