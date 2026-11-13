import { FunctionSpec, GenericId, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicMutation({
      name: "generateUploadUrl",
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "getUrl",
      args: () => ({ storageId: GenericId.GenericId("_storage") }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicAction({
      name: "store",
      args: () => ({ text: Schema.String }),
      returns: () => GenericId.GenericId("_storage"),
    }),
  )
  .addFunction(
    FunctionSpec.publicAction({
      name: "get",
      args: () => ({ storageId: GenericId.GenericId("_storage") }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "deleteBlob",
      args: () => ({ storageId: GenericId.GenericId("_storage") }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicAction({
      name: "storeWith",
      args: () => ({
        text: Schema.String,
        contentType: Schema.String,
        sha256: Schema.String,
      }),
      returns: () => GenericId.GenericId("_storage"),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "describe",
      args: () => ({ storageId: GenericId.GenericId("_storage") }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "deleteRaw",
      args: () => ({ storageId: GenericId.GenericId("_storage") }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "storeInMutation",
      args: () => ({ text: Schema.String, contentType: Schema.String }),
      returns: () => Schema.String,
    }),
  )
  .addFunction(
    FunctionSpec.internalMutation({
      name: "storeAndRead",
      args: () => ({
        count: Schema.Finite,
        size: Schema.Finite,
        ids: Schema.Array(GenericId.GenericId("_storage")),
      }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "fileProbe",
      args: () => ({
        nested: Schema.Boolean,
        count: Schema.Finite,
        size: Schema.Finite,
        ids: Schema.Array(GenericId.GenericId("_storage")),
        filesWritten: Schema.Finite,
        fileWriteBytes: Schema.Finite,
        filesRead: Schema.Finite,
        fileReadBytes: Schema.Finite,
      }),
      returns: () => Schema.String,
    }),
  );
