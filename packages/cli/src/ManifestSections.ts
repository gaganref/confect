import type { GroupSpec, ManifestSection } from "@confect/core";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { LoadedLeafModule } from "./LeafModule.js";
import {
  InvalidDeclarationError,
  InvalidManifestSectionError,
} from "./CodegenError.js";

const reserved = new Set(
  "name env http digest __proto__ constructor prototype".split(" "),
);
export const sections = (manifest: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !reserved.has(key)),
  );
// Read property descriptors rather than values, so no getter or `toJSON` runs
// before the check and nothing `JSON.stringify` would call, skip or convert passes.
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
  const isArray = Array.isArray(value);
  const prototypes = isArray ? [Array.prototype] : [Object.prototype, null];
  if (!prototypes.includes(Object.getPrototypeOf(value))) return path;
  const keys = isArray
    ? Array.from(value.keys(), String)
    : Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === "symbol") return path;
    const at = `${path}[${JSON.stringify(key)}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      key === "__proto__" ||
      !descriptor?.enumerable ||
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
  }
>;
const hasFormat = (format: number) =>
  Schema.is(Schema.Struct({ format: Schema.Literal(format) }));
type Summarized = {
  readonly section: ManifestSection.Any;
  readonly data: { readonly format: number };
};

export const collect = (
  leaves: ReadonlyArray<
    Pick<LoadedLeafModule, "spec" | "pathSegments" | "relativePath">
  >,
) =>
  Result.gen(function* () {
    const registry: Registry = new Map();
    const visit = (
      group: GroupSpec.AnyWithProps,
      path: string,
      source: string,
    ): Result.Result<void, InvalidDeclarationError> =>
      Result.gen(function* () {
        for (const spec of Object.values(group.functions)) {
          const functionPath = `${path}:${spec.name}`;
          for (const { key, section } of spec.manifestSections ?? []) {
            const invalid = (reason: string) =>
              new InvalidDeclarationError({
                declarationPath: `confect/${source}`,
                reason: `Manifest section "${key}" (${functionPath}): ${reason}`,
              });
            if (reserved.has(key))
              return yield* Result.fail(invalid("shadows a built-in key."));
            const existing = registry.get(key);
            if (
              existing !== undefined &&
              (existing.section.owner !== section.owner ||
                existing.section.format !== section.format)
            )
              return yield* Result.fail(
                invalid(
                  `conflicts between ${existing.section.owner} (format ${existing.section.format}) and ${section.owner} (format ${section.format}).`,
                ),
              );
            const entry = existing ?? {
              section,
              data: {
                format: section.format,
                functions: Object.create(null) as Record<string, unknown>,
              },
            };
            registry.set(key, entry);
            const description = yield* Result.try({
              try: () =>
                section.describe({
                  path: functionPath,
                  spec,
                  middleware: [
                    ...group.middlewareSpecs,
                    ...spec.middlewareSpecs,
                  ],
                }),
              catch: (cause) => invalid(String(cause)),
            });
            entry.data.functions[functionPath] = yield* Result.mapError(
              json(description),
              (reason) => invalid(`could not describe as JSON: ${reason}`),
            );
          }
        }
        for (const [name, child] of Object.entries(group.groups))
          yield* visit(child, `${path}/${name}`, source);
      });
    for (const leaf of leaves)
      yield* visit(leaf.spec, leaf.pathSegments.join("/"), leaf.relativePath);
    return registry;
  });

/**
 * Replace the data of each section that has `summarize` with what it returns
 * from its matched modules and its functions' descriptions.
 */
export const summarize = (
  registry: Registry,
  modules: ReadonlyMap<string, ManifestSection.GenerateInput["modules"]>,
) =>
  Result.gen(function* () {
    const summarized = new Map<string, Summarized>(registry);
    for (const [key, { section, data }] of registry) {
      if (section.summarize === undefined) continue;
      const input = {
        modules: modules.get(key) ?? [],
        functions: data.functions,
      };
      const invalid = (reason: string) =>
        new InvalidManifestSectionError({ sectionKey: key, reason });
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
          new InvalidManifestSectionError({
            sectionKey: key,
            reason: [...new Set(checked.errors)].join("\n"),
          }),
        );
    } catch (cause) {
      errors.push(
        new InvalidManifestSectionError({
          sectionKey: key,
          reason: `check failed: ${String(cause)}`,
        }),
      );
    }
  }
  for (const [key, value] of Object.entries(previous)) {
    if (
      !reserved.has(key) &&
      !registry.has(key) &&
      Predicate.isObjectOrArray(value) &&
      "functions" in value &&
      Predicate.isObjectOrArray(value.functions)
    )
      notes.push(
        `Manifest section "${key}" no longer has participants. Previous functions: ${Object.keys(value.functions).join(", ")}.`,
      );
  }
  return { errors, notes };
};
