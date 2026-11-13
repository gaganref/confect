import { GroupSpec, Spec } from "@confect/core";
import hello from "../hello.spec.js";

const spec: Spec.Spec<{
  readonly hello: GroupSpec.NamedAt<typeof hello, "hello">;
}> = Spec.fromGroups({
  ["hello"]: hello,
}) as typeof spec;

export default spec;
