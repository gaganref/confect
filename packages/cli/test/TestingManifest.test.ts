import { confectFunctions, groupsOf } from "@confect/cli/TestingManifest";
import { FunctionSpec, GroupSpec } from "@confect/core";
import { describe, expect, it } from "@effect/vitest";
import * as Array from "effect/Array";
import * as Schema from "effect/Schema";

const notes = GroupSpec.make()
  .addFunction(
    FunctionSpec.publicQuery({ name: "get", returns: () => Schema.String }),
  )
  .addFunction(
    FunctionSpec.internalMutation({
      name: "purge",
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.httpAction({
      name: "receive",
      method: "POST",
      path: "/hooks",
      returns: () => Schema.String,
    }),
  );

const hooks = GroupSpec.make().addFunction(
  FunctionSpec.httpAction({
    name: "ping",
    method: "GET",
    path: "/ping",
    returns: () => Schema.String,
  }),
);

describe("TestingManifest", () => {
  it("hands a section's testing no route, which Convex never registers", () => {
    expect(
      groupsOf([
        { spec: notes, pathSegments: ["notes"] },
        { spec: hooks, pathSegments: ["hooks"] },
      ]),
    ).toEqual([
      {
        path: "notes",
        segments: ["notes"],
        functions: [
          {
            name: "get",
            kind: "query",
            visibility: "public",
            provenance: "Confect",
          },
          {
            name: "purge",
            kind: "mutation",
            visibility: "internal",
            provenance: "Confect",
          },
        ],
      },
    ]);
  });

  it("lists no route among the functions the secret policy reads refs for", () => {
    expect(
      Array.map(
        confectFunctions({ notes, hooks }),
        ({ segments, name, visibility }) => ({ segments, name, visibility }),
      ),
    ).toEqual([
      { segments: ["notes"], name: "get", visibility: "public" },
      { segments: ["notes"], name: "purge", visibility: "internal" },
    ]);
  });
});
