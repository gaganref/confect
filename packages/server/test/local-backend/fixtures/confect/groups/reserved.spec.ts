import { GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { args, profile, snapshot } from "../reservedContext";

const hopMap = () => Schema.Record(Schema.String, Schema.String);
const inlineResult = () =>
  Schema.Struct({
    parent: snapshot(),
    child: snapshot(),
    plain: Schema.String,
    hops: hopMap(),
  });
export default GroupSpec.make()
  .addFunction(
    profile.publicMutation({ name: "echo", args, returns: snapshot }),
  )
  .addFunction(
    profile.publicAction({ name: "echoAction", args, returns: snapshot }),
  )
  .addFunction(
    profile.publicMutation({ name: "inline", args, returns: inlineResult }),
  )
  .addFunction(
    profile.publicMutation({ name: "write", args, returns: () => Schema.Null }),
  )
  .addFunction(
    profile.publicQuery({
      name: "read",
      args,
      returns: () => Schema.NullOr(snapshot()),
    }),
  )
  .addFunction(
    profile.publicAction({
      name: "chain",
      args,
      returns: () =>
        Schema.Struct({
          mutation: snapshot(),
          action: snapshot(),
          inline: inlineResult(),
          jobId: Schema.String,
          hops: hopMap(),
        }),
    }),
  );
