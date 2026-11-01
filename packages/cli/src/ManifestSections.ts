import type { GroupSpec, ManifestSection } from "@confect/core";
import * as Result from "effect/Result";
import type { LoadedLeafModule } from "./LeafModule.js";
import { InvalidDeclarationError } from "./CodegenError.js";

const reserved = new Set(
  "name env http digest __proto__ constructor prototype".split(" "),
);
const json = (_key: string, value: unknown) => {
  if (
    !["string", "number", "boolean", "object"].includes(typeof value) ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    throw new TypeError("Expected JSON data");
  return value;
};
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
            entry.data.functions[functionPath] = yield* Result.try({
              try: () =>
                JSON.parse(
                  JSON.stringify(
                    section.describe({
                      path: functionPath,
                      spec,
                      middleware: [
                        ...group.middlewareSpecs,
                        ...spec.middlewareSpecs,
                      ],
                    }),
                    json,
                  ),
                ),
              catch: (cause) =>
                invalid(`could not describe as JSON: ${String(cause)}`),
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
