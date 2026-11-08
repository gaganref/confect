import { Policy } from "./policy";
import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import notes from "./_generated/tables/notes";
export default GroupSpec.make().middleware(Policy).addFunction(FunctionSpec.publicQuery({ name: "list", returns: () => Schema.Array(notes.Doc) }));
