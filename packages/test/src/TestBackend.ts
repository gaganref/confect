import type { ManifestSection, Ref } from "@confect/core";
import * as MountSteps from "@confect/core/MountSteps";
import type { DatabaseSchema, RegisteredConvexFunction } from "@confect/server";
import { makeFunctionReference } from "convex/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { open, registerKit } from "./internal/Session.js";
import {
  TestConfect,
  type ComponentKit,
  type DeclaredApp,
  type RegisterComponent,
} from "./TestConfect.js";

declare const process: { env: Record<string, string | undefined> };

/**
 * Who answers for a group's access proof: the product, or the Frame door that
 * hosts the group in the product, such as `door:auth`.
 */
export type Owner = "product" | `door:${string}`;

type PublicMap = Readonly<Record<string, Ref.AnyPublic>>;

/**
 * A public group: its path as its refs name it, such as `tasks/tasks`, its
 * owner, its public functions `F`, and `O`, the functions a role held for
 * `public`, `signedIn` or `self` admits.
 */
export interface Group<
  F extends PublicMap,
  O extends keyof F & string = never,
> {
  readonly path: string;
  readonly owner: Owner;
  readonly functions: F;
  readonly open: ReadonlyArray<O>;
}

export type AnyGroup = Group<PublicMap, string>;

/**
 * A group's public functions.
 */
export type Functions<G> = G extends Group<infer F, any> ? F : never;

/**
 * The functions of a group a scope role admits.
 */
export type Open<G> = G extends Group<any, infer O> ? O : never;

/**
 * A proof the backend owes. Codegen writes one `access` per public group, door
 * groups included, and `realm` when the app declares verifiers. Every other
 * kind comes from a manifest section's declarations.
 */
export type Obligation =
  | { readonly kind: "access"; readonly group: string }
  | { readonly kind: "realm" }
  | ManifestSection.DeclaredObligation;

/**
 * A law the committed image must keep. The schema alone gives `decodes` and
 * `idScope` for every table. Every other law comes from a declaration.
 */
export type Law =
  | { readonly law: "decodes"; readonly table: string }
  | { readonly law: "idScope"; readonly table: string }
  | ManifestSection.DeclaredLaw;

/**
 * A provider port: its name, its input codec and its declared outcomes.
 */
export interface ProviderPort<N extends string, I, O extends string> {
  readonly name: N;
  readonly input: Schema.Codec<I, any>;
  readonly outcomes: readonly [O, ...Array<O>];
}

export type AnyPort = ProviderPort<string, any, string>;

/**
 * What a mount binds one of its component's settings to: a literal value, or a
 * setting of the backend that mounts it, the app or a parent component.
 */
export type Binding = { readonly value: string } | { readonly from: string };

/**
 * An installed component, by component path, with the kit that registers it:
 * `"local"` for a component in the repo, else the kit's package specifier.
 * `env` is what the mount binds, and `required` names the component's settings
 * a session cannot open without. The list is in the order a push runs `init`:
 * each parent before the components it mounts, siblings in mount order.
 */
export interface Mount {
  readonly path: string;
  readonly kit: string;
  readonly env: Readonly<Record<string, Binding>>;
  readonly required: ReadonlyArray<string>;
}

/**
 * An app setting a session needs, with the backend that declares it.
 */
export interface Setting {
  readonly name: string;
  readonly owner: string;
  readonly optional: boolean;
}

/**
 * The values a session takes for its settings. Every required one is named.
 */
export type Config<S extends ReadonlyArray<Setting>> = {
  readonly [
    K in Extract<S[number], { readonly optional: false }>["name"]
  ]: string;
} & {
  readonly [
    K in Extract<S[number], { readonly optional: true }>["name"]
  ]?: string;
};

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
 * What a session opened: each registered component's standing sources, as its
 * kit declared them to `registerComponent`, and the mounts whose `init` ran, in
 * the order they ran.
 */
export interface Opened {
  readonly standing: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * The declared cron jobs of every component's `crons.ts`, the other standing
   * source a drain leaves pending.
   */
  readonly crons: ReadonlyArray<{
    readonly componentPath: string;
    readonly name: string;
    readonly udfPath: string;
  }>;
  readonly initialized: ReadonlyArray<string>;
}

export class Session extends Context.Service<Session, Opened>()(
  "@confect/test/TestBackend/Session",
) {}

export interface LayerOptions<
  S extends DatabaseSchema.AnyWithProps,
  C extends ReadonlyArray<Setting>,
> {
  readonly config: Config<C>;
  /**
   * Writes in one private mutation, after every mount's `init`.
   */
  readonly seed?: Effect.Effect<
    void,
    never,
    RegisteredConvexFunction.MutationServices<S>
  >;
}

/**
 * The subject codegen writes in `_generated/testing.ts`: the app's refs `F`,
 * its public groups `T`, its provider ports `P`, its laws and obligations, the
 * manifest digest they belong to, and a `layer` that opens it on the kernel.
 */
export interface GeneratedBackend<
  F,
  T extends Readonly<Record<string, AnyGroup>>,
  P extends Readonly<Record<string, AnyPort>>,
  S extends DatabaseSchema.AnyWithProps = DatabaseSchema.AnyWithProps,
  C extends ReadonlyArray<Setting> = ReadonlyArray<Setting>,
  L extends ReadonlyArray<Law> = ReadonlyArray<Law>,
  B extends ReadonlyArray<Obligation> = ReadonlyArray<Obligation>,
> {
  readonly refs: F;
  readonly groups: T;
  readonly ports: P;
  readonly laws: L;
  readonly obligations: B;
  readonly manifestDigest: string;
  readonly mounts: ReadonlyArray<Mount>;
  readonly settings: C;
  readonly app: GeneratedApp<S>;
  /**
   * Open a fresh session on the kernel. Every module of every mount loads, then
   * each mount's `init` runs in the order a push runs them, each parent before
   * the components it mounts, then `seed` runs in one mutation.
   */
  readonly layer: (
    options: LayerOptions<S, C>,
  ) => Layer.Layer<
    TestConfect<S> | Session,
    TestConfigMissing | MountInitFailed
  >;
}

/**
 * The registry codegen writes beside the subject. A kit is whatever its package
 * exports: a `register` may take narrower names than any string, and opening a
 * session refuses a kit with neither `register` nor a schema.
 */
export type GeneratedApp<S extends DatabaseSchema.AnyWithProps> = Omit<
  DeclaredApp<S>,
  "components"
> & { readonly components: Readonly<Record<string, unknown>> };

/**
 * The obligations a backend owes, as a union.
 */
export type Owed<B> = B extends { readonly obligations: ReadonlyArray<infer O> }
  ? O
  : never;

/**
 * Declares one generated group; `open` keeps its literal names.
 */
export const group = <
  F extends PublicMap,
  const O extends keyof F & string = never,
>(
  value: Group<F, O>,
): Group<F, O> => value;

/**
 * Declares one generated provider port.
 */
export const port = <N extends string, I, const O extends string>(
  value: ProviderPort<N, I, O>,
): ProviderPort<N, I, O> => value;

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
 * Assemble the generated subject. Only `_generated/testing.ts` calls this.
 */
export const make = <
  F,
  const T extends Readonly<Record<string, AnyGroup>>,
  const P extends Readonly<Record<string, AnyPort>>,
  S extends DatabaseSchema.AnyWithProps,
  const C extends ReadonlyArray<Setting>,
  const L extends ReadonlyArray<Law>,
  const B extends ReadonlyArray<Obligation>,
>(
  app: GeneratedApp<S>,
  declaration: {
    readonly refs: F;
    readonly groups: T;
    readonly ports: P;
    readonly laws: L;
    readonly obligations: B;
    readonly manifestDigest: string;
    readonly mounts: ReadonlyArray<Mount>;
    readonly settings: C;
  },
): GeneratedBackend<F, T, P, S, C, L, B> => ({
  ...declaration,
  app,
  layer: ({ config, seed }) => {
    const service = TestConfect<S>();
    return Layer.effectContext(
      Effect.gen(function* () {
        yield* withSettings(declaration.settings, config);
        const standing: Record<string, ReadonlyArray<string>> = {};
        const record =
          (register: RegisterComponent): RegisterComponent =>
          (componentPath, schema, modules, options) => {
            standing[componentPath] = options?.standing ?? [];
            register(componentPath, schema, modules, options);
          };
        const bound = yield* environments(declaration.mounts, config);
        const opened = open(app.schema, app.convexSchema, app.modules, {
          target: "kernel",
          httpMounts: app.httpMounts,
          ...(app.secrets === undefined ? {} : { secrets: app.secrets }),
          register: (registerComponent) => {
            const recording = record(registerComponent);
            for (const [name, kit] of Rec.toEntries(app.components)) {
              registerKit(recording, name, kit as ComponentKit);
            }
          },
        });
        for (const [path, env] of bound) opened.raw.setEnvironment(path, env);
        // Every module of every mount loads before any init, even when no
        // init or seed calls the kernel.
        yield* Effect.promise(() => opened.raw.open());
        const initialized: Array<string> = [];
        const call = (componentPath: string, name: string, args: unknown) =>
          Effect.promise<unknown>(() =>
            opened.raw.runInComponent(componentPath, (ctx: any) =>
              ctx.runMutation(makeFunctionReference<"mutation">(name), args),
            ),
          );
        // A push runs the inits only when the app has a deploy module.
        if (opened.raw.hasModule("", "confectDeploy") === true)
          yield* MountSteps.run({
            steps: (prefix) => call(prefix ?? "", MountSteps.STEPS, {}),
            init: (mount, functionName, args) =>
              call(mount, functionName, args).pipe(
                Effect.tap(() => Effect.sync(() => initialized.push(mount))),
              ),
            failed: (mount, detail) => MountInitFailed.make({ mount, detail }),
          });
        if (seed !== undefined) yield* opened.service.run(seed);
        return Context.make(service, opened.service).pipe(
          Context.add(Session, {
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
          }),
        );
      }),
    );
  },
});
