import type { DatabaseSchema, RegisteredConvexFunction } from "@confect/server";
import * as MountSteps from "@confect/core/MountSteps";
import { makeFunctionReference } from "convex/server";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import type { Scope } from "effect/Scope";
import * as Str from "effect/String";
import type { GeneratedApp, Mount, Opened, Setting } from "../TestBackend.js";
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
export class TestConfigMissing extends Schema.TaggedError<
  TestConfigMissing,
  { readonly brand: unique symbol }
>()("TestConfigMissing", {
  setting: Schema.String,
  owner: Schema.String,
  docs: Schema.String,
}) {
  override get message() {
    return `The test backend needs the setting ${this.setting}, which ${this.owner} declares. Pass it in layer({ config }). See ${this.docs}.`;
  }
}

const docs = "https://confect.dev/guides/testing#configuration";

/**
 * A mount's `init` failed as a push would report it, so the session does not
 * open.
 */
export class MountInitFailed extends Schema.TaggedError<
  MountInitFailed,
  { readonly brand: unique symbol }
>()("MountInitFailed", { mount: Schema.String, detail: Schema.String }) {
  override get message() {
    return `${this.mount}: init failed: ${this.detail}`;
  }
}

/**
 * Each mount's environment, from what it binds: a literal, or a setting of the
 * backend that mounts it, read from `config` for the app and from the parent's
 * resolved environment for a nested mount. A required setting left without a
 * value fails, naming the mount.
 */
const environments = (
  mounts: ReadonlyArray<Mount>,
  config: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const resolved = new Map<string, Readonly<Record<string, string>>>();
    const parentOf = (path: string) =>
      pipe(
        path,
        Str.lastIndexOf("/"),
        Option.map((slash) => pipe(path, Str.slice(0, slash))),
      );
    for (const mount of mounts) {
      const from = Option.match(parentOf(mount.path), {
        onNone: () => config,
        onSome: (parent) => resolved.get(parent) ?? {},
      });
      const env: Record<string, string> = {};
      for (const [slot, binding] of Rec.toEntries(mount.env)) {
        const value = "value" in binding ? binding.value : from[binding.from];
        if (value !== undefined) env[slot] = value;
      }
      for (const slot of mount.required) {
        if (env[slot] === undefined)
          return yield* TestConfigMissing.make({
            setting: slot,
            owner: `the mount ${mount.path}`,
            docs,
          });
      }
      resolved.set(mount.path, env);
    }
    return resolved;
  });

const withSettings = (
  settings: ReadonlyArray<Setting>,
  config: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    for (const { name, owner, optional } of settings) {
      if (!optional && config[name] === undefined)
        return yield* TestConfigMissing.make({ setting: name, owner, docs });
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = Arr.map(
          settings,
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
 * bind each mount's environment, register every kit, recording each one's
 * standing sources, load every module, run each mount's `init` through
 * `MountSteps.run`, then `seed` in one mutation. `sink` answers the calls a
 * component makes to its callback slots, and `root` is a component subject's
 * own `init`, the root step of the same traversal.
 */
export const openSession = <S extends DatabaseSchema.AnyWithProps>(
  app: GeneratedApp<S>,
  declaration: {
    readonly settings: ReadonlyArray<Setting>;
    readonly mounts: ReadonlyArray<Mount>;
  },
  config: Readonly<Record<string, string | undefined>>,
  seed:
    | Effect.Effect<void, never, RegisteredConvexFunction.MutationServices<S>>
    | undefined,
  options: {
    readonly sink?: Execution.Sink;
    readonly root?: NonNullable<MountSteps.Root["init"]>;
  } = {},
): Effect.Effect<
  {
    readonly service: TestConfect<S>;
    readonly raw: any;
    readonly session: Opened;
  },
  TestConfigMissing | MountInitFailed,
  Scope
> =>
  Effect.gen(function* () {
    yield* withSettings(declaration.settings, config);
    const standing: Record<string, ReadonlyArray<string>> = {};
    const record =
      (register: RegisterComponent): RegisterComponent =>
      (componentPath, schema, modules, registerOptions) => {
        standing[componentPath] = registerOptions?.standing ?? [];
        register(componentPath, schema, modules, registerOptions);
      };
    const bound = yield* environments(declaration.mounts, config);
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
          for (const [name, kit] of Rec.toEntries(app.components)) {
            registerKit(recording, name, kit as ComponentKit);
          }
        },
      },
      options.sink,
    );
    for (const [path, env] of bound) opened.raw.setEnvironment(path, env);
    // Every module of every mount loads before any init, even when no init or
    // seed calls the kernel.
    yield* Effect.promise(() => opened.raw.open());
    const initialized: Array<string> = [];
    const call = (componentPath: string, name: string, args: unknown) =>
      Effect.promise<unknown>(() =>
        opened.raw.runInComponent(componentPath, (ctx: any) =>
          ctx.runMutation(makeFunctionReference<"mutation">(name), args),
        ),
      );
    // A push runs the mounts' inits only when the backend has a deploy module.
    yield* MountSteps.run(
      {
        steps: (prefix) => call(prefix ?? "", MountSteps.STEPS, {}),
        init: (mount, functionName, args) =>
          call(mount, functionName, args).pipe(
            Effect.tap(() => Effect.sync(() => initialized.push(mount))),
          ),
        failed: (mount, detail) => MountInitFailed.make({ mount, detail }),
      },
      {
        init: options.root ?? null,
        nested: opened.raw.hasModule("", "confectDeploy") === true,
      },
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
