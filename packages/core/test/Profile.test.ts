import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as MiddlewareSpec from "@confect/core/MiddlewareSpec";
import * as Profile from "@confect/core/Profile";

interface Quota extends Profile.Fields {
  readonly Type: { readonly quota: number };
}
interface Topic extends Profile.Fields {
  readonly Type: { readonly topic: string };
}

class Trace extends MiddlewareSpec.MiddlewareSpec<Trace>()("Trace", {
  functionTypes: { query: true, mutation: true, action: true },
}) {}
class Limit extends MiddlewareSpec.MiddlewareSpec<Limit>()("Limit", {
  options: () => Schema.Struct({ max: Schema.Finite, label: Schema.String }),
  functionTypes: { query: true, mutation: true, action: true },
}) {}
class Publish extends MiddlewareSpec.MiddlewareSpec<Publish>()("Publish", {
  options: () => Schema.Struct({ channel: Schema.String }),
  functionTypes: { query: false, mutation: true, action: false },
}) {}

const limit = ({ name, fields }: Profile.Info<{ readonly quota: number }>) => ({
  max: fields.quota,
  label: name,
});
const Limited = FunctionSpec.extend<Quota>()({
  middleware: [Trace, Profile.attach(Limit, limit)],
});
const Published = Limited.extend<Topic>()({
  middleware: [
    Profile.attach(Publish, ({ fields }) => ({
      channel: `${fields.topic}:${fields.quota}`,
    })),
  ],
});
const returns = () => Schema.Null;

describe("attach", () => {
  it("computes each function's options from its fields and name", () => {
    const send = Published.publicMutation({
      name: "send",
      quota: 3,
      topic: "notes",
      returns,
    });

    expect(send.middlewareAttachments).toEqual([
      { spec: Trace, options: undefined },
      { spec: Limit, options: { max: 3, label: "send" } },
      { spec: Publish, options: { channel: "notes:3" } },
    ]);
    expectTypeOf<FunctionSpec.MiddlewareSpecs<typeof send>>().toEqualTypeOf<
      typeof Trace | typeof Limit | typeof Publish
    >();
    expectTypeOf(Published.publicQuery).toBeNever();
  });

  it("hands the factory the args unevaluated", () => {
    let ready = false;
    let args = () => ({});
    const Watched = FunctionSpec.extend()({
      middleware: [
        Profile.attach(Limit, (info) => {
          args = info.args;
          return { max: 1, label: info.name };
        }),
      ],
    });
    Watched.publicQuery({
      name: "lazy",
      args: () => {
        if (!ready) throw new ReferenceError("Id is not initialized");
        return { noteId: Schema.String };
      },
      returns,
    });
    ready = true;

    expect(Object.keys(args())).toEqual(["noteId"]);
  });

  it("refuses options the middleware does not accept, and fields the profile lacks", () => {
    FunctionSpec.extend<Quota>()({
      middleware: [
        // @ts-expect-error Limit's options need a label.
        Profile.attach(Limit, ({ fields }) => ({ max: fields.quota })),
      ],
    });
    FunctionSpec.extend<Quota>()({
      middleware: [
        // @ts-expect-error The profile declares no topic field.
        Profile.attach(Publish, ({ fields }) => ({ channel: fields.topic })),
      ],
    });
  });
});
