import type { GroupSpec, ManifestSection } from "@confect/core";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type { LoadedLeafModule } from "./LeafModule.js";
import { InvalidDeclarationError } from "./CodegenError.js";

const reserved = new Set(
  "name env http digest __proto__ constructor prototype".split(" "),
);
export const sections = (manifest: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !reserved.has(key)),
  );
export type Registry = Map<
  string,
  {
    section: ManifestSection.ManifestSection;
    source: string;
    data: { format: number; functions: Record<string, unknown> };
  }
>;

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
              source,
              data: {
                format: section.format,
                functions: Object.create(null) as Record<string, unknown>,
              },
            };
            registry.set(key, entry);
            entry.data.functions[functionPath] = section.describe({
              path: functionPath,
              spec,
              middleware: [...group.middlewareSpecs, ...spec.middlewareSpecs],
            });
          }
        }
        for (const [name, child] of Object.entries(group.groups))
          yield* visit(child, `${path}/${name}`, source);
      });
    for (const leaf of leaves)
      yield* visit(leaf.spec, leaf.pathSegments.join("/"), leaf.relativePath);
    return registry;
  });

export const check = (
  registry: Registry,
  previous: Readonly<Record<string, unknown>>,
) => {
  const errors: InvalidDeclarationError[] = [];
  const notes: string[] = [];
  for (const [key, { section, source, data }] of registry) {
    try {
      const checked = section.check?.(data, previous[key]);
      if (checked === undefined) continue;
      notes.push(...checked.notes);
      if (checked.errors.length > 0)
        errors.push(
          new InvalidDeclarationError({
            declarationPath: `confect/${source}`,
            reason: [...new Set(checked.errors)].join("\n"),
          }),
        );
    } catch (cause) {
      errors.push(
        new InvalidDeclarationError({
          declarationPath: `confect/${source}`,
          reason: `Manifest section "${key}" check failed: ${String(cause)}`,
        }),
      );
    }
  }
  for (const [key, value] of Object.entries(previous)) {
    if (
      !reserved.has(key) &&
      !registry.has(key) &&
      Predicate.isObjectOrArray(value) &&
      Predicate.isObjectOrArray(value.functions)
    )
      notes.push(
        `Manifest section "${key}" no longer has participants. Previous functions: ${Object.keys(value.functions).join(", ")}.`,
      );
  }
  return { errors, notes };
};
