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
  it("passes the optional description to attachments and lazy schema wrappers", () => {
    interface Identity extends Profile.SchemaTransform {
      readonly Type: this["Input"];
    }
    const seen: (readonly [string | undefined, boolean])[] = [];
    const Described = FunctionSpec.extend<
      Profile.NoFields,
      { returns: Identity }
    >()({
      middleware: [
        Profile.attach(Limit, (info) => ({
          max: 1,
          label: info.description ?? info.name,
        })),
      ],
      schemas: {
        returns: (thunk, info) => {
          expectTypeOf(info.description).toEqualTypeOf<string | undefined>();
          seen.push([info.description, "description" in info]);
          return thunk;
        },
      },
    });
    const described = Described.publicQuery({
      name: "read",
      description: "Read notes.",
      returns,
    });
    const omitted = Described.publicQuery({ name: "list", returns });
    expect(
      [described, omitted].map(
        (spec) => spec.middlewareAttachments[0]?.options,
      ),
    ).toEqual([
      { max: 1, label: "Read notes." },
      { max: 1, label: "list" },
    ]);
    expect(seen).toEqual([]);
    Schema.decodeSync(described.functionProvenance.returns)(null);
    Schema.decodeSync(omitted.functionProvenance.returns)(null);
    expect(seen).toEqual([
      ["Read notes.", true],
      [undefined, false],
    ]);
  });

  it("tells a plain middleware from an attachment by its brand, not a spec member", () => {
    class Tagged extends MiddlewareSpec.MiddlewareSpec<Tagged>()("Tagged", {
      functionTypes: { query: true, mutation: true, action: true },
    }) {
      static readonly spec = "trace metadata";
    }
    const Plain = FunctionSpec.extend<Quota>()({ middleware: [Tagged] });

    expect(
      Plain.publicQuery({ name: "read", quota: 1, returns })
        .middlewareAttachments,
    ).toEqual([{ spec: Tagged, options: undefined }]);
  });

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

  it("repeats an attachment an earlier layer made, as a middleware with options repeats", () => {
    const Doubled = Limited.extend()({
      middleware: [
        Profile.attach(Limit, ({ fields }) => ({
          max: fields.quota * 2,
          label: "doubled",
        })),
      ],
    });

    expect(
      Doubled.publicQuery({ name: "read", quota: 2, returns })
        .middlewareAttachments,
    ).toEqual([
      { spec: Trace, options: undefined },
      { spec: Limit, options: { max: 2, label: "read" } },
      { spec: Limit, options: { max: 4, label: "doubled" } },
    ]);
  });

  it("refuses a middleware without options at the attach call", () => {
    // The only factory an optionless middleware admits casts or throws.
    const none = () => undefined as never;
    const middleware = [
      Profile.attach(Limit, limit),
      // @ts-expect-error Trace takes no options, in an array of mixed attachments.
      Profile.attach(Trace, none),
    ];

    expect(() =>
      Limited.extend()({
        // @ts-expect-error Trace takes no options, and Limited already lists it.
        middleware: [Profile.attach(Trace, none)],
      }).publicQuery({ name: "read", quota: 1, returns }),
    ).toThrow('Middleware "Trace" is already attached to function "read"');
    Published.extend()({ middleware });
  });

  it("refuses a field named after a builder option for the function it names", () => {
    interface Named extends Profile.Fields {
      readonly Type: this["Name"] extends "read"
        ? { readonly quota: number; readonly description: string }
        : { readonly quota: number };
    }
    const ByName = FunctionSpec.extend<Named>()({
      middleware: [Profile.attach(Limit, limit)],
    });

    expect(
      ByName.publicMutation({ name: "send", quota: 1, returns })
        .middlewareAttachments,
    ).toEqual([{ spec: Limit, options: { max: 1, label: "send" } }]);
    ByName.publicQuery({
      name: "read",
      quota: 1,
      // @ts-expect-error The read function's description field is a builder option.
      description: "Expected field",
      returns,
    });
  });
});
