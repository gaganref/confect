import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import * as RegistryItems from "@confect/server/RegistryItems";
import { FunctionSpec } from "@confect/core";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

describe("missingRequired", () => {
  it("skips the holes in a sparse list of required middleware", () => {
    const get = FunctionRegistryItem.make({
      functionSpec: FunctionSpec.publicQuery({
        name: "get",
        returns: () => Schema.String,
      }),
      groupMiddlewareAttachments: [],
      handler: () => Effect.succeed("ok"),
    });
    const required: Array<{ readonly key: string }> = [];
    required[1] = { key: "Policy" };

    expect(RegistryItems.missingRequired({ get }, required)).toEqual([
      { functionName: "get", middlewareKey: "Policy" },
    ]);
  });
});
