import type { DatabaseSchema, RegisteredConvexFunction } from "@confect/server";
import * as Manifest from "@confect/core/Manifest";
import * as MountSteps from "@confect/core/MountSteps";
import { makeFunctionReference } from "convex/server";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { absurd, pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Redacted from "effect/Redacted";
import type * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Scope } from "effect/Scope";
import * as Str from "effect/String";
import type { GeneratedApp, Mount, Opened, Setting } from "../TestBackend.js";
import type {
  ComponentKit,
  ComponentRuntimes,
  RegisterComponent,
  TestConfect,
} from "../TestConfect.js";
import type * as Execution from "./Execution.js";
import { markAllFileRead } from "./FileSources.js";
import { type PackagedRefusal, validateAll } from "./PackagedSources.js";
import { open, registerKit } from "./Session.js";

declare const process: { env: Record<string, string | undefined> };

/**
 * A session needs a setting the test did not pass. Codegen never reads `.env`
 * or deployment state, so a test names each value. `supply` is where the value
 * goes in `layer`'s options, such as `mounts.ledger.OBSERVE`, when it is not
 * `config`.
 */
export class TestConfigMissing extends Schema.TaggedError<
  TestConfigMissing,
  { readonly brand: unique symbol }
>()("TestConfigMissing", {
  setting: Schema.String,
  owner: Schema.String,
  docs: Schema.String,
  supply: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    return `The test backend needs the setting ${this.setting}, which ${this.owner} declares. Pass it ${this.supply === undefined ? "in layer({ config })" : `as ${this.supply} in layer()`}. See ${this.docs}.`;
  }
}

/**
 * A value the test passed in `layer({ mounts, automatic })` that `Backend`
 * would refuse, for the same `reason`: a mount or slot the manifest does not
 * leave open, a slot that is not automatic, a plain string for a secret, a
 * provider choice the component would refuse, or a value of the wrong kind. It
 * names the slot and never the value.
 */
export class TestConfigInvalid extends Schema.TaggedError<
  TestConfigInvalid,
  { readonly brand: unique symbol }
>()("TestConfigInvalid", {
  setting: Schema.optionalKey(Schema.String),
  owner: Schema.String,
  supply: Schema.String,
  reason: Schema.Literals([
    "UnknownMount",
    "NotOpen",
    "NotAutomatic",
    "PlainSecret",
    "InvalidChoice",
    "InvalidValue",
  ]),
  docs: Schema.String,
}) {
  override get message() {
    const remedy = {
      UnknownMount: "The manifest lists no such mount.",
      NotOpen: "The manifest does not list this slot as open for the mount.",
      NotAutomatic: "The manifest's root does not declare this slot automatic.",
      PlainSecret: "This secret is a plain string. Wrap it with Redacted.make.",
      InvalidChoice:
        "This provider choice is one the component would refuse. Name one of the providers this selector offers, or a failover or pool of them.",
      InvalidValue:
        "This value does not match its manifest slot. Supply a string of the declared kind; a literals slot takes one of its values.",
    };
    return `The test backend refuses ${this.supply}, for ${this.owner}: ${remedy[this.reason]} See ${this.docs}.`;
  }
}

const docs = "https://confect.dev/guides/testing#configuration";

/**
 * What the test passed for the manifest's open and automatic slots.
 */
export interface Supplied {
  readonly mounts?: Readonly<Record<string, unknown>> | undefined;
  readonly automatic?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Where a refused value goes in `layer`'s options, and who declares its slot.
 */
interface Place {
  readonly setting: string;
  readonly owner: string;
  readonly supply: string;
}

/**
 * A refusal of one slot's value, as the session reports it, case by case, so a
 * reason core adds stops compilation here.
 */
const slotRefusal = (
  place: Place,
  reason: Manifest.SlotRefusal["reason"] | Manifest.AutomaticRefusal["reason"],
): TestConfigMissing | TestConfigInvalid => {
  switch (reason) {
    case "Missing":
      return TestConfigMissing.make({ ...place, docs });
    case "NotAutomatic":
    case "PlainSecret":
    case "InvalidChoice":
    case "InvalidValue":
      return TestConfigInvalid.make({ ...place, reason, docs });
    default:
      return absurd(reason);
  }
};

/**
 * `Manifest.variables`' refusal as the session reports it, case by case, so a
 * refusal or reason core adds stops compilation here: a missing value as
 * `TestConfigMissing`, any other as `TestConfigInvalid` with `Backend`'s
 * reason. An automatic slot's owner is the backend the manifest names.
 */
const sessionRefusal =
  (backend: string) =>
  (
    refusal: Result.Result.Failure<ReturnType<typeof Manifest.variables>>,
  ): TestConfigMissing | TestConfigInvalid => {
    switch (refusal._tag) {
      case "MountRefusal": {
        const { reason } = refusal;
        switch (reason) {
          case "UnknownMount":
            return TestConfigInvalid.make({
              owner: `the mount ${refusal.mount}`,
              supply: `mounts.${refusal.mount}`,
              reason,
              docs,
            });
          default:
            return absurd(reason);
        }
      }
      case "OpenRefusal": {
        const { reason } = refusal;
        switch (reason) {
          case "NotOpen":
            return TestConfigInvalid.make({
              setting: refusal.slot,
              owner: `the mount ${refusal.mount}`,
              supply: `mounts.${refusal.mount}.${refusal.slot}`,
              reason,
              docs,
            });
          default:
            return absurd(reason);
        }
      }
      case "MountSlotRefusal":
        return slotRefusal(
          {
            setting: refusal.slot,
            owner: `the mount ${refusal.mount}`,
            supply: `mounts.${refusal.mount}.${refusal.slot}`,
          },
          refusal.reason,
        );
      case "AutomaticRefusal":
      case "SlotRefusal":
        return slotRefusal(
          {
            setting: refusal.slot,
            owner: backend,
            supply: `automatic.${refusal.slot}`,
          },
          refusal.reason,
        );
      default:
        return absurd(refusal);
    }
  };

/**
 * The deployment variables a stack would write for the manifest's open and
 * automatic slots, checked by the rules `Backend` applies, as the strings
 * Convex stores, with the text of each secret among them.
 */
const deployment = (input: Manifest.Manifest | undefined, supplied: Supplied) =>
  Effect.gen(function* () {
    const env: Record<string, string> = {};
    const secrets: Array<string> = [];
    if (input === undefined) return { env, secrets };
    const manifest = yield* Effect.fromResult(
      Manifest.decode(input, "confect/_generated/manifest.ts"),
    ).pipe(Effect.orDie);
    const values = yield* Effect.fromResult(
      Manifest.variables(manifest, {
        mounts: (supplied.mounts ?? {}) as Readonly<
          Record<string, Readonly<Record<string, unknown>>>
        >,
        automatic: supplied.automatic ?? {},
      }),
    ).pipe(Effect.mapError(sessionRefusal(manifest.name)));
    for (const [variable, value] of Rec.toEntries(values)) {
      if (Redacted.isRedacted(value)) {
        const text = Redacted.value(value) as string;
        env[variable] = text;
        secrets.push(text);
      } else env[variable] = value as string;
    }
    return { env, secrets };
  });

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
 * backend that mounts it, read from `root`, the app's settings and deployment
 * variables, for the app's mounts and from the parent's resolved environment
 * for a nested mount. A required setting left without a value fails, naming the
 * mount.
 */
const environments = (
  mounts: ReadonlyArray<Mount>,
  root: Readonly<Record<string, string | undefined>>,
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
        onNone: () => root,
        onSome: (parent) => resolved.get(parent) ?? {},
      });
      const env: Record<string, string> = {};
      for (const [slot, binding] of Rec.toEntries(mount.env)) {
        const value =
          "value" in binding
            ? binding.value
            : "from" in binding
              ? from[binding.from]
              : undefined;
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
 * Open a generated subject's session on the kernel: check the values for its
 * manifest's open and automatic slots as `Backend` does, check and set its
 * settings, bind each mount's environment, marking each secret among them as an
 * app's secrets are marked, register every kit, recording each one's standing
 * sources, load every module, run each mount's `init` through `MountSteps.run`,
 * then `seed` in one mutation. It reads the registry's packaged files again
 * first, so no session runs on files that changed since codegen.
 * `componentRuntimes` overrides the registry's, `sink` answers the calls a
 * component makes to its callback slots, and `root` is a component subject's
 * own `init`, the root step of the same traversal.
 */
export const openSession = <S extends DatabaseSchema.AnyWithProps>(
  app: GeneratedApp<S>,
  declaration: {
    readonly settings: ReadonlyArray<Setting>;
    readonly mounts: ReadonlyArray<Mount>;
    readonly manifest?: Manifest.Manifest | undefined;
  },
  config: Readonly<Record<string, string | undefined>>,
  seed:
    | Effect.Effect<void, never, RegisteredConvexFunction.MutationServices<S>>
    | undefined,
  options: {
    readonly componentRuntimes?: ComponentRuntimes | undefined;
    readonly sink?: Execution.Sink;
    readonly root?: NonNullable<MountSteps.Root["init"]>;
    readonly supplied?: Supplied;
  } = {},
): Effect.Effect<
  {
    readonly service: TestConfect<S>;
    readonly raw: any;
    readonly session: Opened;
  },
  TestConfigMissing | TestConfigInvalid | MountInitFailed | PackagedRefusal,
  Scope
> =>
  Effect.gen(function* () {
    const variables = yield* deployment(
      declaration.manifest,
      options.supplied ?? {},
    );
    // The app's own automatic settings come from `automatic`, as a
    // deployment's do.
    const root = { ...config, ...variables.env };
    yield* withSettings(declaration.settings, root);
    const standing: Record<string, ReadonlyArray<string>> = {};
    const record =
      (register: RegisterComponent): RegisterComponent =>
      (componentPath, schema, modules, registerOptions) => {
        standing[componentPath] = registerOptions?.standing ?? [];
        register(componentPath, schema, modules, registerOptions);
      };
    const bound = yield* environments(declaration.mounts, root);
    const componentRuntimes =
      options.componentRuntimes ?? app.componentRuntimes;
    const componentSources = yield* validateAll(
      app.packagedSources,
      componentRuntimes,
    );
    const opened = open(
      app.schema,
      app.convexSchema,
      app.modules,
      {
        target: "kernel",
        httpMounts: app.httpMounts,
        ...(app.secrets === undefined ? {} : { secrets: app.secrets }),
        ...(app.sources === undefined
          ? {}
          : { sources: markAllFileRead(app.sources) }),
        ...(componentRuntimes === undefined ? {} : { componentRuntimes }),
        ...(componentSources === undefined ? {} : { componentSources }),
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
    for (const secret of variables.secrets) opened.raw.keepSecret(secret);
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
