import { FunctionSpec, GroupSpec } from "@confect/core";
import type {
  fromAction,
  fromMutation,
  fromQuery,
} from "./componentIdentity";

export default GroupSpec.make()
  .addFunction(FunctionSpec.convexPublicQuery<typeof fromQuery>()("fromQuery"))
  .addFunction(
    FunctionSpec.convexPublicMutation<typeof fromMutation>()("fromMutation"),
  )
  .addFunction(
    FunctionSpec.convexPublicAction<typeof fromAction>()("fromAction"),
  );
