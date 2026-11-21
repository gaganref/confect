import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Result from "effect/Result";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as SchemaToValidator from "@confect/core/SchemaToValidator";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import * as PushCheck from "@confect/server/PushCheck";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import {
  afterEach,
  assert,
  describe,
  expect,
  expectTypeOf,
  it,
} from "@effect/vitest";
import * as Convex from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

vi.mock("convex/server", (importOriginal) =>
  importOriginal<typeof Convex>().then((original) => ({
    ...original,
    queryGeneric: vi.fn(original.queryGeneric),
    internalQueryGeneric: vi.fn(original.internalQueryGeneric),
    mutationGeneric: vi.fn(original.mutationGeneric),
    internalMutationGeneric: vi.fn(original.internalMutationGeneric),
    actionGeneric: vi.fn(original.actionGeneric),
    internalActionGeneric: vi.fn(original.internalActionGeneric),
  })),
);

describe("make", () => {
  it("limits preparation to the six isolate registration kinds", () => {
    expectTypeOf<
      ReturnType<typeof RegisteredConvexFunction.prepare>["_tag"]
    >().toEqualTypeOf<
      | "PublicQuery"
      | "InternalQuery"
      | "PublicMutation"
      | "InternalMutation"
      | "PublicAction"
      | "InternalAction"
    >();
    expectTypeOf<
      Parameters<typeof RegisteredConvexFunction.make>["length"]
    >().toEqualTypeOf<2 | 3>();
  });
  const options = {
    name: "get",
    args: () => ({ value: Schema.String }),
    returns: () => Schema.String,
  };
  it.each([
    {
      name: "public query",
      spec: FunctionSpec.publicQuery(options),
      register: Convex.queryGeneric,
    },
    {
      name: "internal query",
      spec: FunctionSpec.internalQuery(options),
      register: Convex.internalQueryGeneric,
    },
    {
      name: "public mutation",
      spec: FunctionSpec.publicMutation(options),
      register: Convex.mutationGeneric,
    },
    {
      name: "internal mutation",
      spec: FunctionSpec.internalMutation(options),
      register: Convex.internalMutationGeneric,
    },
    {
      name: "public action",
      spec: FunctionSpec.publicAction(options),
      register: Convex.actionGeneric,
    },
    {
      name: "internal action",
      spec: FunctionSpec.internalAction(options),
      register: Convex.internalActionGeneric,
    },
  ])(
    "prepares a closed definition and registers a $name handler",
    ({ spec, register }) => {
      const handler = () => Effect.succeed("ok");
      const item = FunctionRegistryItem.make({
        functionSpec: spec,
        groupMiddlewareAttachments: [],
        handler,
      });
      assert(item._tag === "Confect");
      const database = DatabaseSchema.make({});
      const compileArgs = vi.spyOn(SchemaToValidator, "compileArgsSchema");
      const compileReturns = vi.spyOn(
        SchemaToValidator,
        "compileReturnsSchema",
      );
      const registration = vi.mocked(register);
      registration.mockClear();
      const prepared = RegisteredConvexFunction.prepare(database, item);
      expect(registration).not.toHaveBeenCalled();
      expect(Str.toLowerCase(prepared._tag)).toBe(
        `${spec.functionVisibility}${spec.runtimeAndFunctionType.functionType}`,
      );
      const forwardedHandler = () => Promise.resolve("forwarded");
      const registered = RegisteredConvexFunction.register({
        ...prepared,
        handler: forwardedHandler,
      });
      expect(compileArgs).not.toHaveBeenCalled();
      expect(compileReturns).not.toHaveBeenCalled();
      expect(registration).toHaveBeenCalledOnce();
      const [preparedCall] = registration.mock.calls;
      assert(preparedCall);
      const boundary = preparedCall[0];
      assert(typeof boundary !== "function");
      expect(Object.is(boundary, prepared)).toBe(false);
      expect(boundary.handler).toBe(forwardedHandler);
      expect(Object.getOwnPropertyDescriptor(boundary, "args")).toMatchObject({
        get: expect.any(Function),
      });
      expect(
        Object.getOwnPropertyDescriptor(boundary, "returns"),
      ).toMatchObject({
        get: expect.any(Function),
      });
      const exported = registered as unknown as {
        exportArgs: () => string;
        exportReturns: () => string;
      };
      const argsJson = exported.exportArgs();
      expect(compileArgs).toHaveBeenCalledOnce();
      expect(compileReturns).not.toHaveBeenCalled();
      const returnsJson = exported.exportReturns();
      expect(compileReturns).toHaveBeenCalledOnce();
      expect(exported.exportArgs()).toBe(argsJson);
      expect(exported.exportReturns()).toBe(returnsJson);
      expect(compileArgs).toHaveBeenCalledOnce();
      expect(compileReturns).toHaveBeenCalledOnce();
      expect(
        Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(
          argsJson,
        ).pipe(Result.getOrThrow),
      ).toEqual({
        type: "object",
        value: { value: { fieldType: { type: "string" }, optional: false } },
      });
      expect(
        Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(
          returnsJson,
        ).pipe(Result.getOrThrow),
      ).toEqual({ type: "string" });
      registration.mockClear();
      RegisteredConvexFunction.make(database, item);
      expect(registration).toHaveBeenCalledOnce();
      const [call] = registration.mock.calls;
      assert(call);
      const [definition] = call;
      assert(typeof definition !== "function");
      expect(definition.args).toEqual(prepared.args());
      expect(definition.returns).toEqual(prepared.returns());
      expect(item.handler).toBe(handler);
    },
  );

  // `@confect/test`'s kernel reads the mark, since a module's "use node"
  // directive is gone once it loads.
  it.each([
    { spec: FunctionSpec.publicQuery(options), mark: undefined },
    { spec: FunctionSpec.internalMutation(options), mark: undefined },
    { spec: FunctionSpec.publicAction(options), mark: false },
    { spec: FunctionSpec.internalAction(options), mark: false },
  ])(
    "marks the runtime of a registered action as Convex's isolate, and no other function",
    ({ spec, mark }) => {
      const item = FunctionRegistryItem.make({
        functionSpec: spec,
        groupMiddlewareAttachments: [],
        handler: () => Effect.succeed("ok"),
      });
      assert(item._tag === "Confect");
      const registered = RegisteredConvexFunction.make(
        DatabaseSchema.make({}),
        item,
      ) as unknown as Record<symbol, unknown>;
      expect(registered[Symbol.for("@confect/server/NodeAction")]).toBe(mark);
    },
  );
});

describe("invocation context", () => {
  it.each([
    { type: "mutation", reserves: true },
    { type: "action", reserves: true },
    { type: "query", reserves: true },
    { type: "mutation", reserves: false },
    { type: "action", reserves: false },
  ] as const)(
    "projects private metadata at root creation for $type, reserved $reserves",
    ({ type, reserves }) => {
      const profile = FunctionSpec.extend()({
        middleware: [],
        reservedArgument: "context",
      });
      const roots: Array<unknown> = [];
      let current: Fiber.Fiber<any, any> | undefined;
      const runtime = Layer.succeed(
        Tracer.Tracer,
        Tracer.make({
          context(effect, fiber) {
            const previous = current;
            current = fiber;
            try {
              return effect["~effect/Effect/evaluate"](fiber);
            } finally {
              current = previous;
            }
          },
          span(options) {
            roots.push(current?.getRef(RegisteredFunction.Received));
            return new Tracer.NativeSpan(options);
          },
        }),
      );
      const options = {
        name: "echo",
        args: () => ({ value: Schema.String }),
        returns: () => Schema.String,
      };
      const spec = reserves
        ? profile[
            type === "mutation"
              ? "publicMutation"
              : type === "action"
                ? "publicAction"
                : "publicQuery"
          ](options)
        : type === "mutation"
          ? FunctionSpec.publicMutation(options)
          : FunctionSpec.publicAction(options);
      const item = FunctionRegistryItem.make({
        functionSpec: spec,
        groupMiddlewareAttachments: [],
        handler: ({ value }) => Effect.succeed(value),
      });
      assert(item._tag === "Confect");
      const prepared = RegisteredConvexFunction.prepare(
        DatabaseSchema.make({}),
        item,
        [],
        runtime,
      );
      const meta = {
        getFunctionMetadata: () =>
          Promise.resolve({
            name: "items:echo",
            type,
            visibility: "public",
            componentPath: "",
          }),
        getRequestMetadata: () =>
          Promise.resolve({
            requestId: "request-1",
            authToken: "fixture-private-token",
          }),
      };
      const ctx = {
        meta,
        db: { system: {} },
        auth: {},
        storage: {},
        scheduler: {},
        runQuery: () => Promise.resolve(null),
        runMutation: () => Promise.resolve(null),
        runAction: () => Promise.resolve(null),
        vectorSearch: () => Promise.resolve([]),
      };
      vi.stubEnv("CONVEX_CLOUD_URL", "https://fixture.convex.cloud");
      return prepared
        .handler(ctx as never, { value: "ok", context: null })
        .then((result) => {
          expect(result).toBe("ok");
          return prepared.handler(ctx as never, { value: "again" });
        })
        .then((result) => {
          expect(result).toBe("again");
          expect(roots).toEqual(
            type === "query" || !reserves
              ? [undefined, undefined]
              : [
                  {
                    value: null,
                    requestId: "request-1",
                    deployment: "https://fixture.convex.cloud",
                    visibility: "public",
                  },
                  {
                    value: undefined,
                    requestId: "request-1",
                    deployment: "https://fixture.convex.cloud",
                    visibility: "public",
                  },
                ],
          );
          return Effect.runPromise(
            Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
              roots,
            ),
          );
        })
        .then((rootsJson) => {
          expect(rootsJson).not.toContain("fixture-private-token");
          const plain = RegisteredConvexFunction.prepare(
            DatabaseSchema.make({}),
            item,
          );
          const unreadable = {
            ...ctx,
            meta: {
              getFunctionMetadata: () =>
                Promise.reject(new Error("No metadata read without a runtime")),
              getRequestMetadata: () =>
                Promise.reject(
                  new Error("No private metadata read without a runtime"),
                ),
            },
          };
          return plain
            .handler(unreadable as never, { value: "plain" })
            .then((value) => expect(value).toBe("plain"));
        })
        .finally(() => vi.unstubAllEnvs());
    },
  );
});

describe("received visibility", () => {
  const options = {
    reservedArgument: "context",
    name: "echo",
    args: () => ({ value: Schema.String }),
    returns: () => Schema.String,
  };

  const readReceived = (
    spec: FunctionSpec.AnyWithProps,
    functionMetadata: Record<string, unknown>,
    requestMetadata: {
      readonly getRequestMetadata?: () => Promise<unknown>;
    } = {
      getRequestMetadata: () =>
        Promise.resolve({ requestId: "request-1", authToken: "unused" }),
    },
  ) => {
    const roots: Array<unknown> = [];
    let current: Fiber.Fiber<any, any> | undefined;
    const runtime = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        context(effect, fiber) {
          const previous = current;
          current = fiber;
          try {
            return effect["~effect/Effect/evaluate"](fiber);
          } finally {
            current = previous;
          }
        },
        span(spanOptions) {
          roots.push(current?.getRef(RegisteredFunction.Received));
          return new Tracer.NativeSpan(spanOptions);
        },
      }),
    );
    const item = FunctionRegistryItem.make({
      functionSpec: spec,
      groupMiddlewareAttachments: [],
      handler: ({ value }) => Effect.succeed(value),
    });
    assert(item._tag === "Confect");
    const prepared = RegisteredConvexFunction.prepare(
      DatabaseSchema.make({}),
      item,
      [],
      runtime,
    );
    const ctx = {
      meta: {
        getFunctionMetadata: () =>
          Promise.resolve({
            name: "items:echo",
            componentPath: "",
            ...functionMetadata,
          }),
        ...requestMetadata,
      },
      db: { system: {} },
      auth: {},
      storage: {},
      scheduler: {},
      runQuery: () => Promise.resolve(null),
      runMutation: () => Promise.resolve(null),
      runAction: () => Promise.resolve(null),
      vectorSearch: () => Promise.resolve([]),
    };
    vi.stubEnv("CONVEX_CLOUD_URL", "https://fixture.convex.cloud");
    return prepared
      .handler(ctx as never, { value: "ok", context: null })
      .then(() => roots)
      .finally(() => vi.unstubAllEnvs());
  };

  it.each([
    {
      name: "public mutation",
      spec: FunctionSpec.publicMutation(options),
      type: "mutation",
      visibility: "public",
    },
    {
      name: "internal mutation",
      spec: FunctionSpec.internalMutation(options),
      type: "mutation",
      visibility: "internal",
    },
    {
      name: "public action",
      spec: FunctionSpec.publicAction(options),
      type: "action",
      visibility: "public",
    },
    {
      name: "internal action",
      spec: FunctionSpec.internalAction(options),
      type: "action",
      visibility: "internal",
    },
  ] as const)(
    "a $name sees its own visibility on the root span",
    ({ spec, type, visibility }) =>
      readReceived(spec, { type, visibility }).then(([received]) =>
        expect(received).toEqual({
          value: null,
          requestId: "request-1",
          deployment: "https://fixture.convex.cloud",
          visibility,
        }),
      ),
  );

  it.each([
    { name: "public query", spec: FunctionSpec.publicQuery(options) },
    { name: "internal query", spec: FunctionSpec.internalQuery(options) },
  ] as const)(
    "a reserving $name sees its received value with no request ID, as Convex gives a query no request metadata",
    ({ spec }) =>
      readReceived(spec, { type: "query", visibility: "public" }, {}).then(
        ([received]) =>
          expect(received).toStrictEqual({
            value: null,
            requestId: undefined,
            deployment: "https://fixture.convex.cloud",
            visibility: "public",
          }),
      ),
  );

  it("a reserving mutation whose runtime rejects request metadata sees no request ID", () =>
    readReceived(
      FunctionSpec.publicMutation(options),
      { type: "mutation", visibility: "public" },
      {
        getRequestMetadata: () =>
          Promise.reject(new Error("This runtime answers no request metadata")),
      },
    ).then(([received]) =>
      expect(received).toStrictEqual({
        value: null,
        requestId: undefined,
        deployment: "https://fixture.convex.cloud",
        visibility: "public",
      }),
    ));

  it.each([
    { name: "mutation", spec: FunctionSpec.publicMutation(options) },
    { name: "action", spec: FunctionSpec.publicAction(options) },
  ] as const)(
    "a $name with no visibility from Convex has none on the root span",
    ({ name, spec }) =>
      readReceived(spec, { type: name }).then(([received]) =>
        expect(received).toStrictEqual({
          value: null,
          requestId: "request-1",
          deployment: "https://fixture.convex.cloud",
        }),
      ),
  );
});

describe("register", () => {
  const preparedFor = Symbol.for(
    "@confect/server/RegisteredConvexFunction/preparedFor/v1",
  );

  /**
   * A query prepared for a backend of its own, whose push check refuses.
   */
  const preparedQuery = () => {
    const item = FunctionRegistryItem.make({
      functionSpec: FunctionSpec.publicQuery({
        name: "get",
        returns: () => Schema.String,
      }),
      groupMiddlewareAttachments: [],
      handler: () => Effect.succeed("ok"),
    });
    assert(item._tag === "Confect");
    const database = DatabaseSchema.make({});
    PushCheck.register(
      database,
      PushCheck.make("authz", () => ["role editor has no level"]),
    );
    return RegisteredConvexFunction.prepare(database, item);
  };

  const exportArgs = (registered: unknown) =>
    (registered as { readonly exportArgs: () => string }).exportArgs();

  const thrown = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it("registers a definition without push check metadata unguarded, as before", () => {
    const { [preparedFor]: _metadata, ...unprepared } = preparedQuery() as {
      readonly [preparedFor]?: unknown;
    } & RegisteredConvexFunction.Definition;
    const registered = RegisteredConvexFunction.register(
      unprepared as RegisteredConvexFunction.Definition,
    );
    expect(PushCheck.targetOf(registered)).toBeUndefined();
    expect(() => exportArgs(registered)).not.toThrow();
  });

  it("refuses a definition whose push check metadata has a null schema, naming its function", () => {
    const error = thrown(() =>
      RegisteredConvexFunction.register({
        ...preparedQuery(),
        [preparedFor]: { schema: null, name: "get" },
      } as unknown as RegisteredConvexFunction.Definition),
    );
    expect(error).toBeInstanceOf(
      RegisteredConvexFunction.InvalidPreparedDefinition,
    );
    expect(error).toMatchObject({
      _tag: "InvalidPreparedDefinition",
      functionName: "get",
      message:
        'The prepared definition of "get" carries invalid push check metadata (its schema is not a database schema), so registering it would skip its backend\'s push checks',
    });
  });

  it.each([
    { value: "authz", reason: "expected an object, got string" },
    { value: null, reason: "expected an object, got null" },
    { value: 1, reason: "expected an object, got number" },
  ])(
    "refuses a definition whose push check metadata is $value, not an object",
    ({ value, reason }) => {
      const error = thrown(() =>
        RegisteredConvexFunction.register({
          ...preparedQuery(),
          [preparedFor]: value,
        } as unknown as RegisteredConvexFunction.Definition),
      );
      expect(error).toBeInstanceOf(
        RegisteredConvexFunction.InvalidPreparedDefinition,
      );
      expect(error).toMatchObject({
        _tag: "InvalidPreparedDefinition",
        reason,
      });
    },
  );

  it("guards a definition whose push check metadata is valid, refusing through PushRefused", () => {
    const registered = RegisteredConvexFunction.register({
      ...preparedQuery(),
    });
    expect(thrown(() => exportArgs(registered))).toMatchObject({
      _tag: "PushRefused",
      check: "authz",
      entry: "get",
      refusals: ["role editor has no level"],
    });
  });
});

describe("reserving queries", () => {
  const argsOf = (spec: FunctionSpec.AnyWithProps): unknown => {
    const item = FunctionRegistryItem.make({
      functionSpec: spec,
      groupMiddlewareAttachments: [],
      handler: () => Effect.succeed("ok"),
    });
    assert(item._tag === "Confect");
    const registered = RegisteredConvexFunction.make(
      DatabaseSchema.make({}),
      item,
    ) as unknown as { exportArgs: () => string };
    return Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(
      registered.exportArgs(),
    ).pipe(Result.getOrThrow);
  };
  const options = {
    name: "echo",
    args: () => ({ value: Schema.String }),
    returns: () => Schema.String,
  };

  it("accepts any optional value under a query's reserved argument, and adds nothing to one without", () => {
    expect(
      argsOf(
        FunctionSpec.publicQuery({ ...options, reservedArgument: "context" }),
      ),
    ).toEqual({
      type: "object",
      value: {
        value: { fieldType: { type: "string" }, optional: false },
        context: { fieldType: { type: "any" }, optional: true },
      },
    });
    expect(argsOf(FunctionSpec.publicQuery(options))).toEqual({
      type: "object",
      value: { value: { fieldType: { type: "string" }, optional: false } },
    });
  });

  it("removes the reserved value before a query's handler decodes its arguments", () => {
    const item = FunctionRegistryItem.make({
      functionSpec: FunctionSpec.publicQuery({
        name: "keys",
        reservedArgument: "context",
        args: () => ({ value: Schema.String }),
        returns: () => Schema.Array(Schema.String),
      }),
      groupMiddlewareAttachments: [],
      handler: (args) => Effect.succeed(Rec.keys(args)),
    });
    assert(item._tag === "Confect");
    const prepared = RegisteredConvexFunction.prepare(
      DatabaseSchema.make({}),
      item,
    );
    const ctx = {
      meta: {
        getFunctionMetadata: () =>
          Promise.resolve({ name: "items:keys", componentPath: "" }),
      },
      db: { system: {} },
      auth: {},
      storage: {},
      runQuery: () => Promise.resolve(null),
    };
    return prepared
      .handler(ctx as never, { value: "ok", context: { run: "r" } })
      .then((keys) => expect(keys).toEqual(["value"]));
  });
});

/**
 * A fresh module graph of `@confect/server` and what it imports, so each test
 * binds the definition hook on a copy no other test touched. Its
 * `convex/server` is this file's mock, made afresh.
 */
const freshServer = () => {
  vi.resetModules();
  return Promise.all([
    import("@confect/server/RegisteredConvexFunction"),
    import("@confect/server/FunctionRegistryItem"),
    import("@confect/server/DatabaseSchema"),
    import("@confect/core/FunctionSpec"),
    import("@confect/core/SchemaToValidator"),
    import("convex/server"),
  ]).then(([registered, items, schemas, specs, validators, convex]) => {
    const options = {
      name: "echo",
      args: () => ({ value: Schema.String }),
      returns: () => Schema.String,
    };
    const prepare = (spec: FunctionSpec.AnyWithProps) => {
      const item = items.make({
        functionSpec: spec,
        groupMiddlewareAttachments: [],
        handler: () => Effect.succeed("ok"),
      });
      assert(item._tag === "Confect");
      return registered.prepare(schemas.make({}), item);
    };
    return {
      Registered: registered,
      convex,
      validators,
      prepare,
      kinds: [
        {
          spec: specs.publicQuery(options),
          visibility: "public",
          generic: convex.queryGeneric,
        },
        {
          spec: specs.internalQuery(options),
          visibility: "internal",
          generic: convex.internalQueryGeneric,
        },
        {
          spec: specs.publicMutation(options),
          visibility: "public",
          generic: convex.mutationGeneric,
        },
        {
          spec: specs.internalMutation(options),
          visibility: "internal",
          generic: convex.internalMutationGeneric,
        },
        {
          spec: specs.publicAction(options),
          visibility: "public",
          generic: convex.actionGeneric,
        },
        {
          spec: specs.internalAction(options),
          visibility: "internal",
          generic: convex.internalActionGeneric,
        },
      ] as const,
    };
  });
};

describe("bindDefinitionHook", () => {
  it.effect("registers each definition unchanged while no hook is bound", () =>
    Effect.gen(function* () {
      const { Registered, prepare, kinds } = yield* Effect.promise(freshServer);
      for (const { spec, generic } of kinds) {
        const registration = vi.mocked(generic);
        registration.mockClear();
        const prepared = prepare(spec);
        Registered.register(prepared);
        const [call] = registration.mock.calls;
        assert(call);
        const [definition] = call;
        assert(typeof definition !== "function");
        expect(new Set(Reflect.ownKeys(definition))).toEqual(
          new Set(["args", "handler", "returns"]),
        );
        expect(definition.handler).toBe(prepared.handler);
        expect(
          Object.getOwnPropertyDescriptor(definition, "args"),
        ).toMatchObject({ get: expect.any(Function) });
      }
    }),
  );

  it.effect(
    "hands the bound hook each registration's visibility and definition, and registers what it returns",
    () =>
      Effect.gen(function* () {
        const { Registered, prepare, kinds, validators } =
          yield* Effect.promise(freshServer);
        const compileArgs = vi.spyOn(validators, "compileArgsSchema");
        const seen: Array<{
          readonly visibility: string;
          readonly definition: RegisteredConvexFunction.ConvexDefinition;
          readonly replacement: RegisteredConvexFunction.ConvexDefinition;
        }> = [];
        Registered.bindDefinitionHook((visibility, definition) => {
          const replacement = {
            handler: (ctx: unknown, args: unknown) =>
              definition.handler(ctx, args),
          };
          seen.push({ visibility, definition, replacement });
          return replacement;
        });
        for (const { spec, visibility, generic } of kinds) {
          const registration = vi.mocked(generic);
          registration.mockClear();
          const prepared = prepare(spec);
          Registered.register(prepared);
          const last = seen.at(-1);
          assert(last);
          expect(last.visibility).toBe(visibility);
          expect(last.definition.handler).toBe(prepared.handler);
          expect(registration).toHaveBeenCalledWith(last.replacement);
        }
        expect(seen).toHaveLength(kinds.length);
        expect(compileArgs).not.toHaveBeenCalled();
      }),
  );

  it.effect("never hands the hook a definition Convex already registered", () =>
    Effect.gen(function* () {
      const { Registered, convex } = yield* Effect.promise(freshServer);
      const hook = vi.fn(
        (
          _visibility: "public" | "internal",
          definition: RegisteredConvexFunction.ConvexDefinition,
        ) => definition,
      );
      Registered.bindDefinitionHook(hook);
      const raw = convex.queryGeneric({ handler: () => "raw" });
      expect(
        Registered.register(Registered.Definition.Registered({ handler: raw })),
      ).toBe(raw);
      expect(hook).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "refuses a second bind, even of the same hook, and keeps the first",
    () =>
      Effect.gen(function* () {
        const { Registered, prepare, kinds } =
          yield* Effect.promise(freshServer);
        const first = vi.fn(
          (
            _visibility: "public" | "internal",
            definition: RegisteredConvexFunction.ConvexDefinition,
          ) => definition,
        );
        const second = vi.fn(
          (
            _visibility: "public" | "internal",
            definition: RegisteredConvexFunction.ConvexDefinition,
          ) => definition,
        );
        Registered.bindDefinitionHook(first);
        for (const hook of [first, second]) {
          const thrown = (() => {
            try {
              Registered.bindDefinitionHook(hook);
              return undefined;
            } catch (error) {
              return error;
            }
          })();
          expect(thrown).toBeInstanceOf(Registered.DefinitionHookRefused);
          expect(thrown).toMatchObject({ reason: "AlreadyBound" });
        }
        Registered.register(prepare(kinds[0].spec));
        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "refuses a bind after a function has registered, and leaves later registrations unhooked",
    () =>
      Effect.gen(function* () {
        const { Registered, prepare, kinds } =
          yield* Effect.promise(freshServer);
        Registered.register(prepare(kinds[0].spec));
        const hook = vi.fn(
          (
            _visibility: "public" | "internal",
            definition: RegisteredConvexFunction.ConvexDefinition,
          ) => definition,
        );
        expect(() => Registered.bindDefinitionHook(hook)).toThrow(
          "A function was registered before the definition hook was bound",
        );
        const registration = vi.mocked(kinds[2].generic);
        registration.mockClear();
        const prepared = prepare(kinds[2].spec);
        Registered.register(prepared);
        expect(hook).not.toHaveBeenCalled();
        const [call] = registration.mock.calls;
        assert(call);
        const [definition] = call;
        assert(typeof definition !== "function");
        expect(definition.handler).toBe(prepared.handler);
      }),
  );
});
