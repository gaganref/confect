import {
  App,
  Auth,
  Env,
  type Http,
  Manifest,
  type Mount as CoreMount,
} from "@confect/core";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- a synchronous hash of in-memory strings in a pure function; Effect's Crypto is a service.
import { createHash } from "node:crypto";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { quote, stringify } from "./Json.js";

/**
 * A backend's declaration (`confect/env.ts`, `app.ts`, `auth.ts`) reduced to
 * the plain data codegen renders. The evaluated modules are parsed into this
 * once, at {@link parse}; every renderer below is a pure function of it.
 */
export interface Declaration {
  readonly target: "app" | "component";
  readonly name: string;
  readonly env: ReadonlyArray<readonly [string, Env.Descriptor]>;
  /**
   * The slots this backend's mounts leave open, under the names it declares
   * them by, `<MOUNT>_<SLOT>`. Codegen adds them to the backend's own Convex
   * env and binds each mount's slot to its promoted name.
   */
  readonly promoted: ReadonlyArray<readonly [string, Env.Descriptor]>;
  /**
   * Automatic slots inherited from children and declared once under their own
   * names.
   */
  readonly automatic: ReadonlyArray<readonly [string, Env.Descriptor]>;
  /**
   * Provider settings of a child whose selector this backend binds to one of
   * its own selectors, under their promoted names and tagged with that
   * selector. The manifest lists them in its own env, where the selector is.
   */
  readonly adopted: ReadonlyArray<readonly [string, Env.Descriptor]>;
  readonly mounts: ReadonlyArray<Mount>;
  readonly providers: Option.Option<ReadonlyArray<Provider>>;
}

export interface Mount {
  readonly name: string;
  readonly importPath: string;
  readonly componentName: string;
  readonly httpPrefix: string | undefined;
  readonly env: ReadonlyArray<readonly [string, Binding]>;
  /**
   * The generated manifest the mounted component ships, when it ships one.
   */
  readonly descriptor: Manifest.Manifest | undefined;
  /**
   * The component's slots this mount leaves unbound, each with its promoted
   * name.
   */
  readonly open: ReadonlyArray<readonly [string, Manifest.OpenSlot]>;
}

export type Binding =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "env"; readonly key: string };

export type ProviderValue =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "siteUrl" | "cloudUrl"; readonly path: string }
  | { readonly kind: "env"; readonly key: string };

export type Provider = ReadonlyArray<readonly [string, ProviderValue]>;

export class NotADeclaration extends Schema.TaggedError<
  NotADeclaration,
  { readonly brand: unique symbol }
>()("NotADeclaration", { file: Schema.String, expected: Schema.String }) {
  override get message(): string {
    return `${this.file} must default-export ${this.expected}.`;
  }
}

export class InvalidEnvKey extends Schema.TaggedError<
  InvalidEnvKey,
  { readonly brand: unique symbol }
>()("InvalidEnvKey", { key: Schema.String }) {
  override get message(): string {
    return `"${this.key}" is not a valid Convex environment variable name; use letters, digits and underscores, starting with a letter.`;
  }
}

export class InvalidDerivedEnvKey extends Schema.TaggedError<
  InvalidDerivedEnvKey,
  { readonly brand: unique symbol }
>()("InvalidDerivedEnvKey", {
  mount: Schema.String,
  slot: Schema.String,
  variable: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `The mount "${this.mount}" derives ${this.variable} from slot ${this.slot}. ${this.reason} Rename the mount or slot.`;
  }
}

export class InvalidMountName extends Schema.TaggedError<
  InvalidMountName,
  { readonly brand: unique symbol }
>()("InvalidMountName", { mount: Schema.String }) {
  override get message(): string {
    return `"${this.mount}" is not a valid mount name; use letters, digits and underscores, starting with a letter or underscore.`;
  }
}

export class ReservedMountName extends Schema.TaggedError<
  ReservedMountName,
  { readonly brand: unique symbol }
>()("ReservedMountName", { mount: Schema.String }) {
  override get message(): string {
    return `The mount name "${this.mount}" is reserved for the root app or docs page; choose another mount name.`;
  }
}

export class ForeignEnvBinding extends Schema.TaggedError<
  ForeignEnvBinding,
  { readonly brand: unique symbol }
>()("ForeignEnvBinding", {
  mount: Schema.String,
  slot: Schema.String,
  backend: Schema.String,
  key: Schema.String,
  expectedBackend: Schema.String,
}) {
  override get message(): string {
    return `The mount "${this.mount}" binds ${this.slot} to ${this.key} of the "${this.backend}" env, but this backend's env is "${this.expectedBackend}".`;
  }
}

export class InvalidBinding extends Schema.TaggedError<
  InvalidBinding,
  { readonly brand: unique symbol }
>()("InvalidBinding", { mount: Schema.String, slot: Schema.String }) {
  override get message(): string {
    return `The mount "${this.mount}" binds ${this.slot} to something other than a string or an entry of this backend's env.`;
  }
}

export class InvalidComponentDefinition extends Schema.TaggedError<
  InvalidComponentDefinition,
  { readonly brand: unique symbol }
>()("InvalidComponentDefinition", { index: Schema.Finite }) {
  override get message(): string {
    return `App.make's components[${this.index}] must be the default export of a component's convex.config module, imported directly in the declaration.`;
  }
}

export class MountWithoutDefinition extends Schema.TaggedError<
  MountWithoutDefinition,
  { readonly brand: unique symbol }
>()("MountWithoutDefinition", {
  mount: Schema.String,
  component: Schema.String,
}) {
  override get message(): string {
    return `The mount "${this.mount}" mounts the component "${this.component}", but App.make's components lists no definition named "${this.component}".`;
  }
}

export class DefinitionWithoutMount extends Schema.TaggedError<
  DefinitionWithoutMount,
  { readonly brand: unique symbol }
>()("DefinitionWithoutMount", {
  component: Schema.String,
  importPath: Schema.String,
}) {
  override get message(): string {
    return `App.make's components lists the definition "${this.component}" from ${this.importPath}, but no mount mounts it.`;
  }
}

export class DuplicateMountName extends Schema.TaggedError<
  DuplicateMountName,
  { readonly brand: unique symbol }
>()("DuplicateMountName", {
  mount: Schema.String,
  first: Schema.String,
  second: Schema.String,
}) {
  override get message(): string {
    return `Two mounts are named "${this.mount}", one of "${this.first}" and one of "${this.second}"; give each mount its own name.`;
  }
}

export class DuplicateDefinitionName extends Schema.TaggedError<
  DuplicateDefinitionName,
  { readonly brand: unique symbol }
>()("DuplicateDefinitionName", {
  component: Schema.String,
  first: Schema.String,
  second: Schema.String,
}) {
  override get message(): string {
    return `Two component definitions are named "${this.component}", from ${this.first} and ${this.second}; give each definition its own name.`;
  }
}

export class AuthForAnotherBackend extends Schema.TaggedError<
  AuthForAnotherBackend,
  { readonly brand: unique symbol }
>()("AuthForAnotherBackend", {
  backend: Schema.String,
  expectedBackend: Schema.String,
}) {
  override get message(): string {
    return `confect/auth.ts declares auth for the "${this.backend}" backend, but confect/app.ts declares "${this.expectedBackend}".`;
  }
}

export class InvalidProviderEnv extends Schema.TaggedError<
  InvalidProviderEnv,
  { readonly brand: unique symbol }
>()("InvalidProviderEnv", {
  field: Schema.String,
  key: Schema.String,
  backend: Schema.String,
}) {
  override get message(): string {
    return `Auth provider field "${this.field}" requires a non-secret, required string entry of the "${this.backend}" env; got "${this.key}".`;
  }
}

export class RootMountEnv extends Schema.TaggedError<
  RootMountEnv,
  { readonly brand: unique symbol }
>()("RootMountEnv", {
  mount: Schema.String,
  slots: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `The app's mount "${this.mount}" binds ${Arr.join(this.slots, ", ")}. A root app's mount is placement only; leave the slot open and supply it from the stack.`;
  }
}

export class DerivedSlotCollision extends Schema.TaggedError<
  DerivedSlotCollision,
  { readonly brand: unique symbol }
>()("DerivedSlotCollision", {
  variable: Schema.String,
  first: Schema.String,
  second: Schema.String,
}) {
  override get message(): string {
    return `${this.first} and ${this.second} both take the name ${this.variable}; rename a mount or a slot.`;
  }
}

export class DuplicateRouteIdentity extends Schema.TaggedError<
  DuplicateRouteIdentity,
  { readonly brand: unique symbol }
>()("DuplicateRouteIdentity", {
  owner: Schema.String,
  group: Schema.String,
  endpoint: Schema.String,
  first: Schema.Struct({ method: Schema.String, path: Schema.String }),
  second: Schema.Struct({ method: Schema.String, path: Schema.String }),
}) {
  override get message(): string {
    return `The route identity ${this.owner}.${this.group}.${this.endpoint} names both ${this.first.method} ${this.first.path} and ${this.second.method} ${this.second.path}. Rename an endpoint or mount so each identity names one route.`;
  }
}

export class AutomaticSlotConflict extends Schema.TaggedError<
  AutomaticSlotConflict,
  { readonly brand: unique symbol }
>()("AutomaticSlotConflict", {
  mount: Schema.String,
  slot: Schema.String,
  /**
   * The sibling mount whose automatic slot of this name has another shape;
   * absent when this backend's own slot is the other one.
   */
  declaredBy: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.declaredBy === undefined
      ? `The mount "${this.mount}" declares ${this.slot} automatic, but this backend declares an ordinary slot or another shape with that name. Declare ${this.slot} with Env.automatic and the same kind, values and optionality as the child, or rename the conflicting slot.`
      : `The mount "${this.mount}" declares ${this.slot} automatic with another kind, values or optionality than the mount "${this.declaredBy}" does. Give both components the same automatic ${this.slot}, or rename one.`;
  }
}

export class InvalidSelectorBinding extends Schema.TaggedError<
  InvalidSelectorBinding,
  { readonly brand: unique symbol }
>()("InvalidSelectorBinding", {
  mount: Schema.String,
  slot: Schema.String,
  reason: Schema.Literals([
    "NotASelector",
    "DifferentProviders",
    "InvalidChoice",
  ]),
}) {
  override get message(): string {
    const remedy = {
      NotASelector:
        "binds it to a slot that is not an Env.providers selector. Bind it to a selector with the same providers, or to a constant choice.",
      DifferentProviders:
        "binds it to a selector that offers other providers. Offer the same providers in both selectors.",
      InvalidChoice:
        "binds it to a constant the component would refuse. Name one of its providers, or a failover or pool of them.",
    };
    return `The mount "${this.mount}" leaves its provider selector ${this.slot} to this backend, which ${remedy[this.reason]}`;
  }
}

export type DeclarationError =
  | NotADeclaration
  | InvalidEnvKey
  | InvalidDerivedEnvKey
  | InvalidMountName
  | ReservedMountName
  | ForeignEnvBinding
  | InvalidBinding
  | InvalidComponentDefinition
  | MountWithoutDefinition
  | DefinitionWithoutMount
  | DuplicateMountName
  | DuplicateDefinitionName
  | AuthForAnotherBackend
  | InvalidProviderEnv
  | Manifest.UnsupportedManifestFormat
  | RootMountEnv
  | DerivedSlotCollision
  | Env.ReservedEnvKey
  | AutomaticSlotConflict
  | InvalidSelectorBinding;

const ENV_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const MOUNT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The declaration file a parse error is about.
 */
export const fileOf = (error: DeclarationError): string =>
  error._tag === "NotADeclaration"
    ? error.file
    : error._tag === "AuthForAnotherBackend" ||
        error._tag === "InvalidProviderEnv"
      ? "confect/auth.ts"
      : "confect/app.ts";

/**
 * A mounted component's import as the generated `convex.config.ts` writes it.
 */
export interface ComponentImport {
  readonly importPath: string;
  readonly componentName: string;
}

const plainDescriptor = ({
  variable: _,
  ...descriptor
}: Manifest.OpenSlot): Env.Descriptor => descriptor;

const legacySlot = (schema: Schema.Top): Env.Descriptor => {
  const ast = SchemaAST.toType(schema.ast);
  const optional = SchemaAST.isOptional(schema.ast);
  const representation = ast.annotations?.representation;
  if (
    SchemaAST.isDeclaration(ast) &&
    Predicate.isObject(representation) &&
    representation.id === "effect/schema/Redacted"
  )
    return { kind: "secret", optional };
  const types = SchemaAST.isUnion(ast) ? ast.types : [ast];
  const members = optional
    ? Arr.filter(types, (type) => type._tag !== "Undefined")
    : types;
  const values = Arr.filterMap(members, (type) =>
    SchemaAST.isLiteral(type) && typeof type.literal === "string"
      ? Result.succeed(type.literal)
      : Result.fail(undefined),
  );
  return values.length === members.length && Arr.isArrayNonEmpty(values)
    ? { kind: "literals", values, optional }
    : { kind: "string", optional };
};

/**
 * A mount's open slot under its promoted name, its provider tag naming its
 * selector by the selector's promoted name too.
 */
const flattened = (
  slot: Manifest.OpenSlot,
  record: Readonly<Record<string, Manifest.OpenSlot>>,
): readonly [string, Env.Descriptor] => {
  const descriptor = plainDescriptor(slot);
  return [
    slot.variable,
    descriptor.provider === undefined
      ? descriptor
      : {
          ...descriptor,
          provider: {
            ...descriptor.provider,
            // The decoded manifest's tags name a slot of their own record.
            selector: record[descriptor.provider.selector]!.variable,
          },
        },
  ];
};

/**
 * The env slots a mounted component declares. A component that ships its
 * manifest declares its own slots and its mounts' open slots, under their
 * promoted names. Legacy schemas preserve literal unions and redacted slots;
 * other schemas contribute string slots.
 */
const slotsOf = (
  component: CoreMount.Data["component"],
  descriptor: Manifest.Manifest | undefined,
): ReadonlyArray<readonly [string, Env.Descriptor]> =>
  descriptor !== undefined
    ? [
        ...Rec.toEntries(descriptor.env),
        ...Arr.flatMap(Rec.values(descriptor.mounts), ({ env }) =>
          Arr.map(Rec.values(env), (slot) => flattened(slot, env)),
        ),
      ]
    : Arr.map(
        Rec.toEntries(component.env ?? {}),
        ([key, schema]) => [key, legacySlot(schema)] as const,
      );

/**
 * Whether two automatic slots of one name agree on everything but who declares
 * them.
 */
const sameShape = (a: Env.Descriptor, b: Env.Descriptor): boolean =>
  a.kind === b.kind && a.optional === b.optional && sameValues(a, b);

const valuesOf = (descriptor: Env.Descriptor): ReadonlyArray<string> =>
  descriptor.kind === "literals" || descriptor.kind === "providers"
    ? descriptor.values
    : [];

const sameValues = (a: Env.Descriptor, b: Env.Descriptor): boolean => {
  const left = new Set(valuesOf(a));
  const right = new Set(valuesOf(b));
  return (
    Arr.every([...left], (value) => right.has(value)) &&
    Arr.every([...right], (value) => left.has(value))
  );
};

/**
 * A provider setting as an ordinary slot, once a constant choice has settled
 * whether it is read.
 */
const untagged = (
  descriptor: Env.Descriptor,
  optional: boolean,
): Env.Descriptor =>
  descriptor.kind === "literals" || descriptor.kind === "providers"
    ? { kind: descriptor.kind, values: descriptor.values, optional }
    : { kind: descriptor.kind, optional };

/**
 * How this backend fills a mounted child's provider selector: with one of its
 * own selectors, or with a constant naming some of the child's providers.
 */
type BoundSelector =
  | { readonly kind: "selector"; readonly key: string }
  | { readonly kind: "constant"; readonly names: ReadonlyArray<string> };

const boundSelector = (
  mount: string,
  slot: string,
  descriptor: Env.Descriptor & { readonly kind: "providers" },
  binding: Binding,
  own: ReadonlyArray<readonly [string, Env.Descriptor]>,
): Result.Result<BoundSelector, InvalidSelectorBinding> => {
  const refuse = (reason: InvalidSelectorBinding["reason"]) =>
    Result.fail(InvalidSelectorBinding.make({ mount, slot, reason }));
  if (binding.kind === "value")
    return Option.match(
      Schema.decodeOption(Env.providerChoice(descriptor.values))(binding.value),
      {
        onNone: () => refuse("InvalidChoice"),
        onSome: (choice) =>
          Result.succeed({
            kind: "constant",
            names: Env.chosen(choice),
          }),
      },
    );
  const parent = Option.getOrUndefined(
    Arr.findFirst(own, ([key]) => key === binding.key),
  )?.[1];
  if (parent?.kind !== "providers") return refuse("NotASelector");
  return sameValues(parent, descriptor)
    ? Result.succeed({ kind: "selector", key: binding.key })
    : refuse("DifferentProviders");
};

export const promotedName = (mount: string, slot: string): string =>
  String.toUpperCase(
    `${pipe(mount, String.replace(/([a-z0-9])([A-Z])/g, "$1_$2"), String.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2"))}_${slot}`,
  );

/**
 * Parse the default exports of `confect/app.ts` and, when present,
 * `confect/auth.ts`. `componentImport` recovers how the generated config
 * imports a listed definition; codegen's bundler records it. Each mount takes
 * the definition whose `defineComponent` name is its component's name.
 */
export const parse = (input: {
  readonly target: "app" | "component";
  readonly app: unknown;
  readonly auth: Option.Option<unknown>;
  readonly componentImport: (
    definition: unknown,
  ) => Option.Option<ComponentImport>;
}): Result.Result<Declaration, DeclarationError> =>
  Result.gen(function* () {
    if (!App.isApp(input.app)) {
      return yield* Result.fail(
        NotADeclaration.make({
          file: "confect/app.ts",
          expected: "App.make(...)",
        }),
      );
    }
    const env = App.env(input.app);
    const name = Env.name(env);
    const descriptors = Env.descriptors(env);
    for (const [key] of descriptors) {
      yield* Env.validateKey(key);
      if (!ENV_KEY.test(key))
        return yield* Result.fail(InvalidEnvKey.make({ key }));
    }

    const definitions = new Map<string, ComponentImport>();
    for (const [index, definition] of App.components(input.app).entries()) {
      const component = input.componentImport(definition);
      if (Option.isNone(component)) {
        return yield* Result.fail(InvalidComponentDefinition.make({ index }));
      }
      const { componentName, importPath } = component.value;
      const named = definitions.get(componentName);
      if (named !== undefined && named.importPath !== importPath) {
        return yield* Result.fail(
          DuplicateDefinitionName.make({
            component: componentName,
            first: named.importPath,
            second: importPath,
          }),
        );
      }
      definitions.set(componentName, component.value);
    }

    const automatic: Array<readonly [string, Env.Descriptor]> = [];
    const automaticFrom = new Map<string, string>();
    const adopted: Array<readonly [string, Env.Descriptor]> = [];
    const mounts: Array<Mount> = [];
    const promoted: Array<readonly [string, Env.Descriptor, string]> = [];
    for (const mount of App.mounts(input.app)) {
      if (mount.name === "app" || mount.name === "docs") {
        return yield* Result.fail(
          ReservedMountName.make({ mount: mount.name }),
        );
      }
      if (!MOUNT_NAME.test(mount.name)) {
        return yield* Result.fail(InvalidMountName.make({ mount: mount.name }));
      }
      const component = definitions.get(mount.component.name);
      if (component === undefined) {
        return yield* Result.fail(
          MountWithoutDefinition.make({
            mount: mount.name,
            component: mount.component.name,
          }),
        );
      }
      const named = Option.getOrUndefined(
        Arr.findFirst(mounts, (declared) => declared.name === mount.name),
      );
      if (named !== undefined) {
        return yield* Result.fail(
          DuplicateMountName.make({
            mount: mount.name,
            first: named.componentName,
            second: component.componentName,
          }),
        );
      }
      const descriptor =
        mount.component.manifest === undefined
          ? undefined
          : yield* Manifest.decode(
              mount.component.manifest,
              component.importPath,
            );
      const bindings: Array<readonly [string, Binding]> = [];
      for (const [slot, bound] of Rec.toEntries(mount.env ?? {})) {
        yield* Env.validateKey(slot);
        if (bound === undefined) continue;
        if (typeof bound === "string") {
          bindings.push([slot, { kind: "value", value: bound }]);
          continue;
        }
        if (!Env.isEntry(bound)) {
          return yield* Result.fail(
            InvalidBinding.make({ mount: mount.name, slot }),
          );
        }
        const origin = Env.origin(bound);
        if (origin.backend !== name) {
          return yield* Result.fail(
            ForeignEnvBinding.make({
              mount: mount.name,
              slot,
              backend: origin.backend,
              key: origin.key,
              expectedBackend: name,
            }),
          );
        }
        bindings.push([slot, { kind: "env", key: origin.key }]);
      }
      if (input.target === "app" && bindings.length > 0) {
        return yield* Result.fail(
          RootMountEnv.make({
            mount: mount.name,
            slots: Arr.map(bindings, ([slot]) => slot),
          }),
        );
      }
      const open: Array<readonly [string, Manifest.OpenSlot]> = [];
      const slots = slotsOf(mount.component, descriptor);
      const selectors = new Map<string, BoundSelector>();
      for (const [slot, slotDescriptor] of slots) {
        if (slotDescriptor.kind !== "providers") continue;
        const bound = Arr.findFirst(bindings, ([key]) => key === slot);
        if (Option.isSome(bound))
          selectors.set(
            slot,
            yield* boundSelector(
              mount.name,
              slot,
              slotDescriptor,
              bound.value[1],
              descriptors,
            ),
          );
      }
      for (const [slot, tagged] of slots) {
        if (
          tagged.automatic === true ||
          tagged.kind === "providers" ||
          tagged.provider !== undefined
        ) {
          yield* Env.validateKey(slot);
          if (!ENV_KEY.test(slot))
            return yield* Result.fail(InvalidEnvKey.make({ key: slot }));
        }
        if (tagged.automatic === true) {
          const own = Arr.findFirst(descriptors, ([key]) => key === slot);
          if (
            Option.isSome(own) &&
            (own.value[1].automatic !== true ||
              !sameShape(own.value[1], tagged))
          ) {
            return yield* Result.fail(
              AutomaticSlotConflict.make({ mount: mount.name, slot }),
            );
          }
          const inherited = Arr.findFirst(automatic, ([key]) => key === slot);
          if (
            Option.isSome(inherited) &&
            !sameShape(inherited.value[1], tagged)
          ) {
            return yield* Result.fail(
              AutomaticSlotConflict.make({
                mount: mount.name,
                slot,
                declaredBy: automaticFrom.get(slot),
              }),
            );
          }
          const declared = Option.orElse(own, () => inherited);
          const taken = Arr.findFirst(promoted, ([key]) => key === slot);
          if (Option.isSome(taken))
            return yield* Result.fail(
              DerivedSlotCollision.make({
                variable: slot,
                first: taken.value[2],
                second: `${mount.name}.${slot}`,
              }),
            );
          if (Option.isNone(declared)) {
            automatic.push([slot, tagged]);
            automaticFrom.set(slot, mount.name);
          }
          bindings.push([slot, { kind: "env", key: slot }]);
          continue;
        }
        if (Arr.some(bindings, ([bound]) => bound === slot)) continue;
        const selector =
          tagged.provider === undefined
            ? undefined
            : selectors.get(tagged.provider.selector);
        // A constant choice leaves unread the settings of providers it does not
        // name, and makes the settings of those it names ordinary slots.
        if (
          selector?.kind === "constant" &&
          tagged.provider !== undefined &&
          !selector.names.includes(tagged.provider.name)
        )
          continue;
        const slotDescriptor: Env.Descriptor =
          selector === undefined || tagged.provider === undefined
            ? tagged
            : selector.kind === "constant"
              ? untagged(tagged, !tagged.provider.required)
              : {
                  ...tagged,
                  provider: { ...tagged.provider, selector: selector.key },
                };
        const variable = promotedName(mount.name, slot);
        yield* Env.validateKey(variable).pipe(
          Result.mapError((error) =>
            InvalidDerivedEnvKey.make({
              mount: mount.name,
              slot,
              variable,
              reason: error.message,
            }),
          ),
        );
        if (!ENV_KEY.test(variable))
          return yield* Result.fail(
            InvalidDerivedEnvKey.make({
              mount: mount.name,
              slot,
              variable,
              reason:
                "Use letters, digits and underscores, starting with a letter.",
            }),
          );
        const taken = Arr.some(
          [...descriptors, ...automatic],
          ([key]) => key === variable,
        )
          ? Option.some(variable)
          : Option.map(
              Arr.findFirst(promoted, ([key]) => key === variable),
              ([, , from]) => from,
            );
        if (Option.isSome(taken)) {
          return yield* Result.fail(
            DerivedSlotCollision.make({
              variable,
              first: taken.value,
              second: `${mount.name}.${slot}`,
            }),
          );
        }
        promoted.push([variable, slotDescriptor, `${mount.name}.${slot}`]);
        if (selector?.kind === "selector")
          adopted.push([variable, slotDescriptor]);
        else open.push([slot, { ...slotDescriptor, variable }]);
        bindings.push([slot, { kind: "env", key: variable }]);
      }
      mounts.push({
        name: mount.name,
        importPath: component.importPath,
        componentName: component.componentName,
        httpPrefix: mount.httpPrefix,
        env: bindings,
        descriptor,
        open,
      });
    }
    for (const [component, { importPath }] of definitions) {
      if (
        !Arr.some(mounts, ({ componentName }) => componentName === component)
      ) {
        return yield* Result.fail(
          DefinitionWithoutMount.make({ component, importPath }),
        );
      }
    }

    const providers: Option.Option<ReadonlyArray<Provider>> = Option.isNone(
      input.auth,
    )
      ? Option.none()
      : Option.some(yield* parseProviders(input.auth.value, name));

    return {
      target: input.target,
      name,
      env: descriptors,
      automatic,
      adopted,
      promoted: Arr.map(
        promoted,
        ([key, descriptor]) => [key, descriptor] as const,
      ),
      mounts,
      providers,
    };
  });

const parseProviders = (
  auth: unknown,
  backend: string,
): Result.Result<ReadonlyArray<Provider>, DeclarationError> => {
  if (!Auth.isAuth(auth)) {
    return Result.fail(
      NotADeclaration.make({
        file: "confect/auth.ts",
        expected: "Auth.make(app, ...)",
      }),
    );
  }
  const authBackend = Env.name(App.env(auth.app));
  if (authBackend !== backend) {
    return Result.fail(
      AuthForAnotherBackend.make({
        backend: authBackend,
        expectedBackend: backend,
      }),
    );
  }
  return Result.gen(function* () {
    const providers: Provider[] = [];
    for (const provider of Auth.providers(auth)) {
      const fields: Array<readonly [string, ProviderValue]> = [];
      for (const [field, value] of Rec.toEntries<
        string,
        Auth.Provider[keyof Auth.Provider]
      >(provider)) {
        const sitePath = Auth.siteUrlPath(value);
        const cloudPath = Auth.cloudUrlPath(value);
        let lowered: ProviderValue;
        if (Env.isEntry(value)) {
          const { backend: owner, key } = Env.origin(value);
          const descriptor = value["~@confect/core/Env/Entry"].descriptor;
          if (
            owner !== backend ||
            descriptor.optional ||
            descriptor.kind === "secret" ||
            !ENV_KEY.test(key)
          ) {
            return yield* Result.fail(
              InvalidProviderEnv.make({ field, key, backend }),
            );
          }
          lowered = { kind: "env", key };
        } else if (sitePath !== undefined) {
          lowered = { kind: "siteUrl", path: sitePath };
        } else if (cloudPath !== undefined) {
          lowered = { kind: "cloudUrl", path: cloudPath };
        } else {
          lowered = {
            kind: "value",
            value: Predicate.isString(value) ? value : stringify(value),
          };
        }
        fields.push([field, lowered]);
      }
      providers.push(fields);
    }
    return providers;
  });
};

export const header = (source: string): string =>
  `// Generated by \`confect codegen\` from ${source}. Do not edit.`;

const GENERATED_PREFIX = "// Generated by `confect codegen` from ";

/**
 * Whether codegen may overwrite or remove an existing file: it carries the
 * generated header, or it is exactly one of the files an earlier codegen wrote
 * there (`legacy`).
 */
export const isGenerated = (
  contents: string,
  legacy: ReadonlyArray<string>,
): boolean =>
  pipe(contents, String.startsWith(GENERATED_PREFIX)) ||
  legacy.includes(contents);

const validator = (descriptor: Env.Descriptor): string => {
  const base =
    descriptor.kind === "literals"
      ? descriptor.values.length === 1
        ? `v.literal(${quote(descriptor.values[0])})`
        : `v.union(${pipe(
            descriptor.values,
            Arr.map((value) => `v.literal(${quote(value)})`),
            Arr.join(", "),
          )})`
      : "v.string()";
  return descriptor.optional ? `v.optional(${base})` : base;
};

const RESERVED = new Set(
  pipe(
    "await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield",
    String.split(" "),
  ),
);

/**
 * A safe import name for a component, from its Convex name.
 */
const identifier = (name: string): string => {
  const cleaned = pipe(name, String.replaceAll(/[^A-Za-z0-9_$]/g, "_"));
  const valid = /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return RESERVED.has(valid) ? `${valid}Component` : valid;
};

/**
 * `convex/convex.config.ts`: Convex's own app or component definition.
 */
export const convexConfig = (declaration: Declaration): string => {
  const self = declaration.target === "app" ? "app" : "component";
  const aliases = new Map<string, string>();
  const taken = new Set([self, "v", "defineApp", "defineComponent"]);
  for (const mount of declaration.mounts) {
    if (aliases.has(mount.importPath)) continue;
    const base = identifier(mount.componentName);
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}${n}`;
    taken.add(alias);
    aliases.set(mount.importPath, alias);
  }

  const lines = [header("confect/app.ts")];
  lines.push(
    declaration.target === "app"
      ? 'import { defineApp } from "convex/server";'
      : 'import { defineComponent } from "convex/server";',
  );
  const env = [
    ...declaration.env,
    ...declaration.automatic,
    ...declaration.promoted,
  ];
  if (env.length > 0) lines.push('import { v } from "convex/values";');
  for (const [importPath, alias] of aliases) {
    lines.push(`import ${alias} from ${quote(importPath)};`);
  }
  lines.push("");

  const envBlock =
    env.length === 0
      ? []
      : [
          "  env: {",
          ...Arr.map(
            env,
            ([key, descriptor]) => `    ${key}: ${validator(descriptor)},`,
          ),
          "  },",
        ];
  if (declaration.target === "app") {
    lines.push(
      envBlock.length === 0
        ? "const app = defineApp();"
        : Arr.join(["const app = defineApp({", ...envBlock, "});"], "\n"),
    );
  } else {
    lines.push(
      envBlock.length === 0
        ? `const component = defineComponent(${quote(declaration.name)});`
        : Arr.join(
            [
              `const component = defineComponent(${quote(declaration.name)}, {`,
              ...envBlock,
              "});",
            ],
            "\n",
          ),
    );
  }

  for (const mount of declaration.mounts) {
    lines.push("");
    lines.push(`${self}.use(${aliases.get(mount.importPath)}, {`);
    lines.push(`  name: ${quote(mount.name)},`);
    if (mount.httpPrefix !== undefined) {
      lines.push(`  httpPrefix: ${quote(mount.httpPrefix)},`);
    }
    if (mount.env.length > 0) {
      lines.push("  env: {");
      for (const [slot, binding] of mount.env) {
        lines.push(
          `    ${slot}: ${binding.kind === "value" ? quote(binding.value) : `${self}.env.${binding.key}`},`,
        );
      }
      lines.push("  },");
    }
    lines.push("});");
  }

  lines.push("", `export default ${self};`, "");
  return Arr.join(lines, "\n");
};

const providerValue = (value: ProviderValue): string => {
  switch (value.kind) {
    case "value":
      return quote(value.value);
    case "env":
      return `process.env[${quote(value.key)}]!`;
    default:
      return `\`\${process.env.${value.kind === "siteUrl" ? "CONVEX_SITE_URL" : "CONVEX_CLOUD_URL"}}${pipe(value.path, String.replaceAll(/[`$\\]/g, "\\$&"))}\``;
  }
};

/**
 * `convex/auth.config.ts`: Convex's provider list, with site URLs resolved
 * there.
 */
export const authConfig = (providers: ReadonlyArray<Provider>): string =>
  Arr.join(
    [
      header("confect/auth.ts"),
      'import type { AuthConfig } from "convex/server";',
      "",
      "export default {",
      providers.length === 0 ? "  providers: []," : "  providers: [",
      ...(providers.length === 0
        ? []
        : [
            ...Arr.flatMap(providers, (provider) => [
              "    {",
              ...pipe(
                provider,
                Arr.filter(([field]) => field !== "family" && field !== "name"),
                Arr.map(
                  ([field, value]) =>
                    `      ${field}: ${providerValue(value)},`,
                ),
              ),
              "    },",
            ]),
            "  ],",
          ]),
      "} satisfies AuthConfig;",
      "",
    ],
    "\n",
  );

/**
 * Runtime issuer data with no dependency on declarations or component
 * definitions.
 */
export const authProviders = (providers: ReadonlyArray<Provider>): string =>
  Arr.join(
    [
      header("confect/auth.ts"),
      "",
      "export const providers = [",
      ...Arr.flatMap(providers, (provider) => [
        "  {",
        ...Arr.flatMap(provider, ([field, value]) => {
          const key =
            field === "domain"
              ? "issuer"
              : field === "applicationID"
                ? "audience"
                : field;
          return ["issuer", "audience", "family", "name"].includes(key)
            ? [`    ${key}: ${providerValue(value)},`]
            : [];
        }),
        "  },",
      ]),
      "] as const;",
      "",
    ],
    "\n",
  );

/**
 * `confect/_generated/manifest.ts`: plain data, no imports, for infra.
 */
export const manifest = (
  declaration: Declaration,
  digest: string,
  sections: Readonly<Record<string, unknown>> = {},
  leaves: ReadonlyArray<Leaf> = [],
): Result.Result<string, DuplicateRouteIdentity> =>
  Result.gen(function* () {
    const data = {
      format: Manifest.FORMAT,
      name: declaration.name,
      env: Rec.fromEntries([
        ...declaration.env,
        ...declaration.automatic,
        ...declaration.adopted,
      ]),
      mounts: Rec.fromEntries(
        Arr.map(
          declaration.mounts,
          ({ name, componentName, httpPrefix, open }) => [
            name,
            {
              component: componentName,
              ...(httpPrefix === undefined ? {} : { httpPrefix }),
              env: Rec.fromEntries(open),
            },
          ],
        ),
      ),
      http: yield* routeCatalogue(leaves, digest),
      digest,
      sections,
    };
    const finalDigest = manifestDigest(digest, data);
    return renderManifest({
      ...data,
      http: yield* routeCatalogue(leaves, finalDigest),
      digest: finalDigest,
    });
  });

type Leaf = Omit<Manifest.Route, "digest">;

const joinPath = (prefix: string, path: string): string =>
  `${pipe(prefix, String.replace(/\/$/, ""))}${path}`;

/**
 * Every route the backend serves: its own endpoints under `app`, and each
 * prefixed mount's routes from the manifest its component ships, with the
 * mount's prefix added and the owner placed under the mount's name. A mount
 * without a prefix serves no routes.
 */
export const routeLeaves = (
  own: ReadonlyArray<Http.Route>,
  mounts: ReadonlyArray<CoreMount.Data>,
): Result.Result<ReadonlyArray<Leaf>, Manifest.UnsupportedManifestFormat> =>
  Result.gen(function* () {
    const leaves: Leaf[] = Arr.flatMap(
      own,
      ({ method, path, group, endpoint }) =>
        group === undefined || endpoint === undefined
          ? []
          : [{ method, path, owner: "app", group, endpoint }],
    );
    for (const { name, httpPrefix, component } of mounts) {
      if (component.manifest === undefined) continue;
      const descriptor = yield* Manifest.decode(
        component.manifest,
        `confect/app.ts (mount ${name}, component ${component.name})`,
      );
      if (httpPrefix === undefined) continue;
      for (const groups of Rec.values(descriptor.http)) {
        for (const endpoints of Rec.values(groups)) {
          for (const leaf of Rec.values(endpoints))
            leaves.push({
              method: leaf.method,
              path: joinPath(httpPrefix, leaf.path),
              owner: leaf.owner === "app" ? name : `${name}/${leaf.owner}`,
              group: leaf.group,
              endpoint: leaf.endpoint,
            });
        }
      }
    }
    return leaves;
  });

/**
 * The manifest's `http`: routes by owner, group and endpoint, each carrying the
 * final digest.
 */
export const routeCatalogue = (
  leaves: ReadonlyArray<Leaf>,
  digest: string,
): Result.Result<Manifest.Manifest["http"], DuplicateRouteIdentity> =>
  Result.gen(function* () {
    const http: Record<
      string,
      Record<string, Record<string, Manifest.Route>>
    > = Object.create(null);
    for (const leaf of leaves) {
      const groups: Record<string, Record<string, Manifest.Route>> = (http[
        leaf.owner
      ] ??= Object.create(null));
      const endpoints: Record<string, Manifest.Route> = (groups[leaf.group] ??=
        Object.create(null));
      const existing = endpoints[leaf.endpoint];
      if (existing !== undefined)
        return yield* Result.fail(
          DuplicateRouteIdentity.make({
            owner: leaf.owner,
            group: leaf.group,
            endpoint: leaf.endpoint,
            first: { method: existing.method, path: existing.path },
            second: { method: leaf.method, path: leaf.path },
          }),
        );
      endpoints[leaf.endpoint] = { ...leaf, digest };
    }
    return http;
  });

/**
 * The route leaves of a manifest written earlier, so a rerun that serves the
 * same routes writes the same manifest. Anything not shaped like a catalogue
 * gives none.
 */
export const previousLeaves = (http: unknown): ReadonlyArray<Leaf> =>
  !Predicate.isObject(http)
    ? []
    : Arr.flatMap(Rec.values(http as Record<string, unknown>), (groups) =>
        !Predicate.isObject(groups)
          ? []
          : Arr.flatMap(
              Rec.values(groups as Record<string, unknown>),
              (endpoints) =>
                !Predicate.isObject(endpoints)
                  ? []
                  : Arr.flatMap(
                      Rec.values(endpoints as Record<string, unknown>),
                      (leaf) =>
                        Predicate.isObject(leaf) &&
                        Predicate.isString(leaf.method) &&
                        Predicate.isString(leaf.path) &&
                        Predicate.isString(leaf.owner) &&
                        Predicate.isString(leaf.group) &&
                        Predicate.isString(leaf.endpoint)
                          ? [
                              {
                                method: leaf.method,
                                path: leaf.path,
                                owner: leaf.owner,
                                group: leaf.group,
                                endpoint: leaf.endpoint,
                              },
                            ]
                          : [],
                    ),
            ),
      );

/**
 * Hash the complete emitted contract together with its source fingerprint.
 */
export const manifestDigest = (
  source: string,
  data: Readonly<Record<string, unknown>>,
): string =>
  digest({ files: [["declaration", source]], versions: [], manifest: data });

export const renderManifest = (
  data: Readonly<Record<string, unknown>>,
): string =>
  `${header("confect/env.ts and confect/app.ts")}\n\nexport default ${pipe(stringify(data, 2), String.replace(/^( *)"__proto__":/gm, '$1["__proto__"]:'))} as const;\n`;

const canonical = (
  value: unknown,
  omitDigests = false,
  path: ReadonlyArray<string> = [],
): unknown => {
  if (Arr.isArray(value))
    return Arr.map(value, (item, index) =>
      canonical(item, omitDigests, [...path, `${index}`]),
    );
  if (!Predicate.isObject(value)) return value;
  return pipe(
    Rec.toEntries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    Arr.filter(
      ([key]) =>
        !(
          omitDigests &&
          key === "digest" &&
          (path.length === 0 || (path[0] === "http" && path.length === 4))
        ),
    ),
    Arr.map(
      ([key, item]) =>
        [key, canonical(item, omitDigests, [...path, key])] as const,
    ),
    Rec.fromEntries,
  );
};

/**
 * Hash source files, generator versions and every semantic manifest field. Only
 * the manifest's own digest and its route digests are omitted.
 */
export const digest = (input: {
  readonly files: ReadonlyArray<readonly [string, string]>;
  readonly versions: ReadonlyArray<readonly [string, string]>;
  readonly sections?: Readonly<Record<string, unknown>>;
  readonly manifest?: Readonly<Record<string, unknown>>;
}): string => {
  const hash = createHash("sha256");
  const byFirst = (
    a: readonly [string, string],
    b: readonly [string, string],
  ) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  hash.update(
    stringify(
      canonical({
        files: Arr.map(
          input.files,
          ([name, contents]) =>
            [name, pipe(contents, String.replaceAll(/\r\n/g, "\n"))] as const,
        ).sort(byFirst),
        versions: [...input.versions].sort(byFirst),
        ...(input.sections === undefined ? {} : { sections: input.sections }),
        ...(input.manifest === undefined
          ? {}
          : { manifest: canonical(input.manifest, true) }),
      }),
    ),
  );
  return `sha256:${hash.digest("hex")}`;
};
