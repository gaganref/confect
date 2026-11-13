import type { DatabaseSchema, RegisteredConvexFunction } from "@confect/server";
import { makeFunctionReference } from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Scope } from "effect/Scope";
import type { GeneratedApp, Opened, Setting } from "../TestBackend.js";
import type {
  ComponentKit,
  RegisterComponent,
  TestConfect,
} from "../TestConfect.js";
import type * as Execution from "./Execution.js";
import { open, registerKit } from "./Session.js";

declare const process: { env: Record<string, string | undefined> };

/**
 * A session needs an app setting the test did not pass. Codegen never reads
 * `.env` or deployment state, so a test names each value.
 */
export class TestConfigMissing extends Schema.TaggedError<TestConfigMissing>()(
  "TestConfigMissing",
  { setting: Schema.String, owner: Schema.String, docs: Schema.String },
) {
  override get message() {
    return `The test backend needs the setting ${this.setting}, which ${this.owner} declares. Pass it in layer({ config }). See ${this.docs}.`;
  }
}

const docs = "https://confect.dev/guides/testing#configuration";

const Steps = Schema.Array(
  Schema.Union([
    Schema.Struct({
      componentPath: Schema.String,
      nested: Schema.Boolean,
      init: Schema.NullOr(
        Schema.Struct({ functionName: Schema.String, args: Schema.Unknown }),
      ),
    }),
    Schema.Struct({ componentPath: Schema.String, failure: Schema.String }),
  ]),
);

const STEPS = "confectDeploy:steps";

const hasDeployModule = (modules: Readonly<Record<string, unknown>>) =>
  "confectDeploy.ts" in modules || "confectDeploy.js" in modules;

/**
 * Run the inits a push runs, through the deploy modules production registers,
 * with each nested component's steps before its own `init`.
 */
const initialize = (
  raw: any,
  hasSteps: (componentPath: string) => boolean,
  initialized: Array<string>,
) => {
  const call = (componentPath: string, functionName: string, args: unknown) =>
    Effect.promise<unknown>(() =>
      raw.runInComponent(componentPath, (ctx: any) =>
        ctx.runMutation(makeFunctionReference<"mutation">(functionName), args),
      ),
    );
  const visit = (prefix: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!hasSteps(prefix)) return;
      const steps = yield* Schema.decodeUnknownEffect(Steps)(
        yield* call(prefix, STEPS, {}),
      ).pipe(Effect.orDie);
      for (const step of steps) {
        const path =
          prefix === ""
            ? step.componentPath
            : `${prefix}/${step.componentPath}`;
        if ("failure" in step)
          return yield* Effect.die(
            new Error(`${path}: init failed: ${step.failure}`),
          );
        if (step.nested) yield* visit(path);
        if (step.init === null) continue;
        yield* call(path, step.init.functionName, step.init.args);
        initialized.push(path);
      }
    });
  return visit("");
};

const withSettings = (
  settings: ReadonlyArray<Setting>,
  config: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    for (const { name, owner, optional } of settings) {
      if (!optional && config[name] === undefined)
        return yield* new TestConfigMissing({ setting: name, owner, docs });
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = settings.map(
          ({ name }) => [name, process.env[name]] as const,
        );
        for (const { name } of settings) {
          const value = config[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        return previous;
      }),
      (previous) =>
        Effect.sync(() => {
          for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }),
    );
  });

/**
 * Open a generated subject's session on the kernel: check and set its settings,
 * register every kit, recording each one's standing sources, load every module,
 * run each mount's `init`, then `seed` in one mutation. `sink` answers the
 * calls a component makes to its callback slots.
 */
export const openSession = <S extends DatabaseSchema.AnyWithProps>(
  app: GeneratedApp<S>,
  settings: ReadonlyArray<Setting>,
  config: Readonly<Record<string, string | undefined>>,
  seed:
    | Effect.Effect<void, never, RegisteredConvexFunction.MutationServices<S>>
    | undefined,
  sink?: Execution.Sink,
): Effect.Effect<
  {
    readonly service: TestConfect<S>;
    readonly raw: any;
    readonly session: Opened;
  },
  TestConfigMissing,
  Scope
> =>
  Effect.gen(function* () {
    yield* withSettings(settings, config);
    const standing: Record<string, ReadonlyArray<string>> = {};
    const record =
      (register: RegisterComponent): RegisterComponent =>
      (componentPath, schema, modules, options) => {
        standing[componentPath] = options?.standing ?? [];
        register(componentPath, schema, modules, options);
      };
    const deployModules = new Set<string>(
      hasDeployModule(app.modules) ? [""] : [],
    );
    const opened = open(
      app.schema,
      app.convexSchema,
      app.modules,
      {
        target: "kernel",
        httpMounts: app.httpMounts,
        ...(app.secrets === undefined ? {} : { secrets: app.secrets }),
        register: (registerComponent) => {
          const recording = record(registerComponent);
          const seen: RegisterComponent = (path, schema, modules, options) => {
            if (hasDeployModule(modules)) deployModules.add(path);
            recording(path, schema, modules, options);
          };
          for (const [name, kit] of Object.entries(app.components)) {
            registerKit(seen, name, kit as ComponentKit);
          }
        },
      },
      sink,
    );
    const initialized: Array<string> = [];
    yield* initialize(
      opened.raw,
      (path) => deployModules.has(path),
      initialized,
    );
    if (seed !== undefined) yield* opened.service.run(seed);
    return {
      service: opened.service,
      raw: opened.raw,
      session: {
        standing,
        crons: opened.raw
          .crons()
          .map(
            ({
              componentPath,
              name,
              udfPath,
            }: {
              readonly componentPath: string;
              readonly name: string;
              readonly udfPath: string;
            }) => ({ componentPath, name, udfPath }),
          ),
        initialized,
      },
    };
  });
