import { pushCheck as pushCheck0 } from "../functions.js";
import * as PushCheck from "@confect/server/PushCheck";
import { RegisteredNodeFunction } from "@confect/server/node";
import databaseSchema from "../schema.js";
import groupLayer from "../../probeNode.impl.js";

export default PushCheck.guardFunctions(RegisteredNodeFunction.buildForGroup<typeof import("../../probeNode.spec.js")["default"]>(databaseSchema, groupLayer), [pushCheck0], "probeNode");
