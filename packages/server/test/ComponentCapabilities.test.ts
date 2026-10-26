import {
  FunctionSpec,
  GenericId,
  GroupSpec,
  IdScope,
  Table,
} from "@confect/core";
import {
  Auth,
  DatabaseReader,
  DatabaseSchema,
  DatabaseWriter,
  FunctionImpl,
  HttpRouter,
  MutationCtx,
  RegisteredConvexFunction,
  StorageReader,
  Scheduler,
} from "@confect/server";
import type {
  DataModel,
  Handler,
  Document,
  QueryInitializer,
  BlobNotFoundError,
} from "@confect/server";
import { describe, expect, it } from "@effect/vitest";
import type { GenericMutationCtx } from "convex/server";
import { makeFunctionReference } from "convex/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Router from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const scope = IdScope.component("@example/counter");
const users = Table.make(() => Schema.Struct({ name: Schema.String }))(
  "users",
  scope,
);
const databaseSchema = DatabaseSchema.make(
  { users },
  { kind: "component", scope },
);
type Database = typeof databaseSchema;
type Model = DataModel.ToConvex<DataModel.FromSchema<Database>>;
const group = GroupSpec.make().addFunction(
  FunctionSpec.publicMutation({
    name: "create",
    args: () => ({}),
    returns: () => Schema.Null,
  }),
);

describe("component capabilities", () => {
  it("allows signing only in app and component mutations", () => {
    const mint = Effect.gen(function* () {
      const auth = yield* Auth.MutationAuth;
      // @ts-expect-error Signing doesn't expose application identity in a component.
      void auth.getUserIdentity;
      return yield* auth.signJwt({
        claims: { sub: "visitor", aud: "tenant" },
        expiresInSeconds: 60,
      });
    });
    const functions = GroupSpec.make()
      .addFunction(
        FunctionSpec.publicMutation({
          name: "mint",
          returns: () => Schema.String,
        }),
      )
      .addFunction(
        FunctionSpec.publicQuery({
          name: "query",
          returns: () => Schema.String,
        }),
      )
      .addFunction(
        FunctionSpec.publicAction({
          name: "action",
          returns: () => Schema.String,
        }),
      );
    for (const schema of [databaseSchema, DatabaseSchema.make({})] as const) {
      FunctionImpl.make(schema, functions, "mint", () => mint);
      // @ts-expect-error Queries cannot sign deployment JWTs.
      FunctionImpl.make(schema, functions, "query", () => mint);
      // @ts-expect-error Actions cannot sign deployment JWTs.
      FunctionImpl.make(schema, functions, "action", () => mint);
    }
    const reserved = (
      auth: Context.Service.Shape<typeof Auth.MutationAuth>,
    ) => {
      // @ts-expect-error Convex owns the issuer claim.
      return auth.signJwt({ claims: { iss: "other" }, expiresInSeconds: 60 });
    };
    void reserved;
  });

  it("keeps the implementation builder while rejecting app authentication", () => {
    const auth = Effect.gen(function* () {
      yield* Auth.Auth;
      return null;
    });
    // @ts-expect-error Component handlers are not provided application Auth.
    FunctionImpl.make(databaseSchema, group, "create", () => auth);
    const rawApp = Effect.gen(function* () {
      yield* MutationCtx.MutationCtx<Model>();
      return null;
    });
    // @ts-expect-error An unscoped raw app context cannot bypass component capabilities.
    FunctionImpl.make(databaseSchema, group, "create", () => rawApp);
    FunctionImpl.make(databaseSchema, group, "create", () =>
      Effect.succeed(null),
    );
    const appScheduler = Effect.gen(function* () {
      yield* Scheduler.Scheduler;
      return null;
    });
    // @ts-expect-error A component cannot acquire root-scoped scheduled-function IDs.
    FunctionImpl.make(databaseSchema, group, "create", () => appScheduler);
  });

  it("scopes database and raw-context IDs", () => {
    const program: Effect.Effect<
      void,
      | Document.DocumentDecodeError
      | Document.DocumentEncodeError
      | QueryInitializer.GetByIdFailure
      | BlobNotFoundError.BlobNotFoundError
      | Schema.SchemaError,
      Handler.MutationServices<Database>
    > = Effect.gen(function* () {
      const writer = yield* DatabaseWriter.DatabaseWriter<Database>();
      const reader = yield* DatabaseReader.DatabaseReader<Database>();
      const id = yield* writer.table("users").insert({ name: "Ada" });
      yield* reader.table("users").get(id);
      const appId = yield* Schema.decodeUnknownEffect(
        GenericId.GenericId("users"),
      )("app-id");
      // @ts-expect-error The host's users table is a different table.
      yield* reader.table("users").get(appId);
      // @ts-expect-error Writes must also reject a foreign ID.
      yield* writer.table("users").delete(appId);
      const raw = yield* MutationCtx.MutationCtx<Model, typeof scope>();
      // @ts-expect-error Component raw contexts don't expose auth.
      void raw.auth;
      yield* Effect.promise(() => raw.db.get("users", id));
      // @ts-expect-error Raw database operations preserve the same ID boundary.
      yield* Effect.promise(() => raw.db.get("users", appId));
      const scheduled = yield* Effect.promise(() =>
        raw.scheduler.runAfter(
          100,
          makeFunctionReference<"mutation", {}>("counter:tick"),
          {},
        ),
      );
      const scoped: GenericId.GenericId<"_scheduled_functions", typeof scope> =
        scheduled;
      void scoped;
      // @ts-expect-error Raw scheduling returns an ID in the component's system table.
      const rootScheduled: GenericId.GenericId<"_scheduled_functions"> =
        scheduled;
      void rootScheduled;
      const storage =
        yield* StorageReader.StorageReader.forScope<typeof scope>();
      const storageId = yield* Schema.decodeUnknownEffect(
        GenericId.GenericId("_storage", scope),
      )("file");
      yield* storage.getUrl(storageId);
      const appStorageId = yield* Schema.decodeUnknownEffect(
        GenericId.GenericId("_storage"),
      )("file");
      // @ts-expect-error File storage is scoped too.
      yield* storage.getUrl(appStorageId);
    });
    void program;
  });

  it("derives HTTP handler capabilities from the same schema", () => {
    const routes = Router.add(
      "GET",
      "/",
      Auth.Auth.pipe(Effect.as(HttpServerResponse.text("OK"))),
    );
    // @ts-expect-error Component HTTP handlers also cannot require application Auth.
    HttpRouter.forSchema(databaseSchema)(routes);
    HttpRouter.forSchema(databaseSchema)(
      Router.add("GET", "/", HttpServerResponse.text("OK")),
    );
  });

  it.effect(
    "omits authentication from the runtime layer and raw context",
    () => {
      // Only ctx construction is faked here; no database or storage method is called.
      const ctx = {
        auth: {},
        db: {},
        scheduler: {},
        storage: {},
        runQuery: () => Promise.resolve(null),
        runMutation: () => Promise.resolve(null),
      } as unknown as GenericMutationCtx<Model>;
      return Effect.gen(function* () {
        const context = yield* Layer.build(
          RegisteredConvexFunction.mutationLayer(databaseSchema, ctx),
        );
        expect(Option.isNone(Context.getOption(context, Auth.Auth))).toBe(true);
        const raw = Context.get(
          context,
          MutationCtx.MutationCtx<Model, typeof scope>(),
        );
        expect(Object.hasOwn(raw, "auth")).toBe(false);
      }).pipe(Effect.scoped);
    },
  );
});
