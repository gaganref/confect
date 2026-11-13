import type { FunctionSpec, GroupSpec, ManifestSection } from "@confect/core";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { LoadedLeafModule } from "./LeafModule.js";
import {
  InvalidDeclarationError,
  InvalidManifestSectionError,
} from "./CodegenError.js";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";

const reserved = new Set(
  pipe("name env http digest __proto__ constructor prototype", Str.split(" ")),
);
export const sections = (manifest: Readonly<Record<string, unknown>>) =>
  Rec.fromEntries(
    Arr.filter(Rec.toEntries(manifest), ([key]) => !reserved.has(key)),
  );
// Read only property descriptors, through static functions, so no getter,
// `toJSON` or other method of the input runs before the check and nothing
// `JSON.stringify` would call, skip or convert passes.
const nonJsonPath = (
  value: unknown,
  path = "$",
  ancestors: ReadonlyArray<object> = [],
): string | undefined => {
  if (value === null || ["string", "boolean"].includes(typeof value))
    return undefined;
  if (typeof value === "number")
    return Number.isFinite(value) ? undefined : path;
  if (typeof value !== "object" || ancestors.includes(value)) return path;
  const isArray = Arr.isArray(value);
  const prototypes = isArray ? [Array.prototype] : [Object.prototype, null];
  if (!prototypes.includes(Object.getPrototypeOf(value))) return path;
  const keys = isArray
    ? Array.from(
        { length: Object.getOwnPropertyDescriptor(value, "length")?.value },
        (_, index) => String(index),
      )
    : Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === "symbol") return path;
    const at = `${path}[${JSON.stringify(key)}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      key === "__proto__" ||
      descriptor?.enumerable !== true ||
      !("value" in descriptor)
    )
      return at;
    const found = nonJsonPath(descriptor.value, at, [...ancestors, value]);
    if (found !== undefined) return found;
  }
  // Every index is an own data property by now, so any other key than `length`
  // is one `JSON.stringify` would drop or call.
  return isArray && Reflect.ownKeys(value).length !== keys.length + 1
    ? path
    : undefined;
};
const json = (value: unknown): Result.Result<unknown, string> => {
  const path = nonJsonPath(value);
  return path === undefined
    ? Result.succeed(JSON.parse(JSON.stringify(value)))
    : Result.fail(`Expected JSON data at ${path}`);
};
export type Registry = Map<
  string,
  {
    section: ManifestSection.Any;
    data: { format: number; functions: Record<string, unknown> };
    sources: Record<string, string>;
  }
>;
const hasFormat = (format: number) =>
  Schema.is(Schema.Struct({ format: Schema.Literal(format) }));
type Summarized = {
  readonly section: ManifestSection.Any;
  readonly data: { readonly format: number };
};

type Leaf = Pick<LoadedLeafModule, "spec" | "pathSegments" | "relativePath">;

const appDeclaration = (reason: string) =>
  InvalidDeclarationError.make({ declarationPath: "confect/app.ts", reason });

/**
 * Refuse a key `App.make` declares twice or that shadows one the manifest keeps
 * for itself.
 */
export const declared = (entries: ReadonlyArray<ManifestSection.Entry>) =>
  Result.gen(function* () {
    const seen = new Set<string>();
    for (const { key } of entries) {
      if (reserved.has(key))
        return yield* Result.fail(
          appDeclaration(`Manifest section "${key}" shadows a built-in key.`),
        );
      if (seen.has(key))
        return yield* Result.fail(
          appDeclaration(`Manifest section "${key}" is declared twice.`),
        );
      seen.add(key);
    }
  });

const visit = (
  leaves: ReadonlyArray<Leaf>,
  each: (
    spec: FunctionSpec.AnyWithProps,
    group: GroupSpec.AnyWithProps,
    path: string,
    source: string,
  ) => Result.Result<void, InvalidDeclarationError>,
) =>
  Result.gen(function* () {
    const walk = (
      group: GroupSpec.AnyWithProps,
      path: string,
      source: string,
    ): Result.Result<void, InvalidDeclarationError> =>
      Result.gen(function* () {
        for (const spec of Rec.values(group.functions))
          yield* each(spec, group, `${path}:${spec.name}`, source);
        for (const [name, child] of Rec.toEntries(group.groups))
          yield* walk(child, `${path}/${name}`, source);
      });
    for (const leaf of leaves)
      yield* walk(
        leaf.spec,
        Arr.join(leaf.pathSegments, "/"),
        leaf.relativePath,
      );
  });

/**
 * Refuse a function spec that still carries `manifestSections`: codegen reads a
 * backend's sections only from `App.make`.
 */
export const refuseSpecSections = (leaves: ReadonlyArray<Leaf>) =>
  visit(leaves, (spec, _, path, source) =>
    Predicate.hasProperty(spec, "manifestSections")
      ? Result.fail(
          InvalidDeclarationError.make({
            declarationPath: `confect/${source}`,
            reason: `${path} carries manifestSections, which codegen no longer reads from a function spec. Declare the backend's manifest sections once, on App.make({ manifestSections }) in confect/app.ts.`,
          }),
        )
      : Result.void,
  );

/**
 * One registry entry per declared section, each describing every registered
 * function in code-unit order of its path, so a section's data never depends on
 * the order the leaves loaded in. A backend with no functions keeps every
 * section, with none.
 */
export const collect = (
  entries: ReadonlyArray<ManifestSection.Entry>,
  leaves: ReadonlyArray<Leaf>,
) =>
  Result.gen(function* () {
    const registry: Registry = new Map(
      Arr.map(entries, ({ key, section }) => [
        key,
        {
          section,
          data: {
            format: section.format,
            functions: Object.create(null) as Record<string, unknown>,
          },
          sources: Object.create(null) as Record<string, string>,
        },
      ]),
    );
    const functions: Array<{
      spec: FunctionSpec.AnyWithProps;
      group: GroupSpec.AnyWithProps;
      path: string;
      source: string;
    }> = [];
    yield* visit(leaves, (spec, group, path, source) => {
      functions.push({ spec, group, path, source });
      return Result.void;
    });
    functions.sort(Order.mapInput(Order.String, ({ path }) => path));
    for (const { spec, group, path, source } of functions) {
      for (const [key, { section, data, sources }] of registry) {
        const invalid = (reason: string) =>
          InvalidDeclarationError.make({
            declarationPath: `confect/${source}`,
            reason: `Manifest section "${key}" (${path}): ${reason}`,
          });
        const description = yield* Result.try({
          try: () =>
            section.describe({
              path,
              spec,
              middleware: [...group.middlewareSpecs, ...spec.middlewareSpecs],
            }),
          catch: (cause) => invalid(String(cause)),
        });
        data.functions[path] = yield* Result.mapError(
          json(description),
          (reason) => invalid(`could not describe as JSON: ${reason}`),
        );
        sources[path] = source;
      }
    }
    return registry;
  });

/**
 * Replace the data of each section that has `summarize` with what it returns
 * from its matched modules, its functions' descriptions and their spec files.
 */
export const summarize = (
  registry: Registry,
  modules: ReadonlyMap<string, ManifestSection.GenerateInput["modules"]>,
) =>
  Result.gen(function* () {
    const summarized = new Map<string, Summarized>(registry);
    for (const [key, { section, data, sources }] of registry) {
      if (section.summarize === undefined) continue;
      const input = {
        modules: modules.get(key) ?? [],
        functions: data.functions,
        sources,
      };
      const invalid = (reason: string) =>
        InvalidManifestSectionError.make({ sectionKey: key, reason });
      const summary = yield* Result.try({
        try: () => section.summarize?.(input),
        catch: (cause) => invalid(`summarize failed: ${String(cause)}`),
      });
      const parsed = yield* Result.mapError(json(summary), (reason) =>
        invalid(`could not summarize as JSON: ${reason}`),
      );
      if (!hasFormat(section.format)(parsed))
        return yield* Result.fail(
          invalid(`summarize must return data with format ${section.format}.`),
        );
      summarized.set(key, { section, data: parsed });
    }
    return summarized;
  });

export const check = (
  registry: ReadonlyMap<string, Summarized>,
  previous: Readonly<Record<string, unknown>>,
) => {
  const errors: InvalidManifestSectionError[] = [];
  const notes: string[] = [];
  for (const [key, { section, data }] of registry) {
    try {
      const checked = section.check?.(data, previous[key]);
      if (checked === undefined) continue;
      notes.push(...checked.notes);
      if (checked.errors.length > 0)
        errors.push(
          InvalidManifestSectionError.make({
            sectionKey: key,
            reason: Arr.join([...new Set(checked.errors)], "\n"),
          }),
        );
    } catch (cause) {
      errors.push(
        InvalidManifestSectionError.make({
          sectionKey: key,
          reason: `check failed: ${String(cause)}`,
        }),
      );
    }
  }
  return { errors, notes };
};
