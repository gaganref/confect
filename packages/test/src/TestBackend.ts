import type { ManifestSection, Ref } from "@confect/core";
import type { DatabaseSchema, RegisteredConvexFunction } from "@confect/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import { openSession } from "./internal/Backend.js";
import type { TestConfigMissing } from "./internal/Backend.js";
import { TestConfect, type DeclaredApp } from "./TestConfect.js";

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
 * An installed component, by component path, with the kit that registers it:
 * `"local"` for a component in the repo, else the kit's package specifier. The
 * list is in the order a session runs `init`: nested mounts before their
 * parent, and siblings in mount order.
 */
export interface Mount {
  readonly path: string;
  readonly kit: string;
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

export { TestConfigMissing } from "./internal/Backend.js";

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
  /**
   * An app's subject. A component's is `TestComponent.GeneratedComponent`.
   */
  readonly kind: "app";
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
   * each mount's `init` runs, nested mounts before their parent, then `seed`
   * runs in one mutation.
   */
  readonly layer: (
    options: LayerOptions<S, C>,
  ) => Layer.Layer<TestConfect<S> | Session, TestConfigMissing>;
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
  kind: "app",
  app,
  layer: ({ config, seed }) => {
    const service = TestConfect<S>();
    return Layer.effectContext(
      Effect.map(
        openSession(app, declaration.settings, config, seed),
        ({ service: opened, session }) =>
          Context.make(service, opened).pipe(Context.add(Session, session)),
      ),
    );
  },
});
