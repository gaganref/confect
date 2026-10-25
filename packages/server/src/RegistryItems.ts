import * as Array from "effect/Array";
import { pipe } from "effect/Function";
import * as Record from "effect/Record";
import * as FunctionRegistryItem from "./FunctionRegistryItem.js";
import * as MiddlewareRegistryItem from "./MiddlewareRegistryItem.js";

/**
 * Runtime tree that mirrors a `Spec`'s group structure. Values remain unknown
 * at this boundary so producers and consumers can narrow branches and registry
 * items as needed.
 */
export interface RegistryItems {
  readonly [key: string]: unknown;
}

/**
 * The names of the function-shaped entries in a group's (flat, isolated)
 * registry. `FunctionImpl.make` registers each function under a single-segment
 * key, so the registry built for one group contains exactly that group's
 * functions at the top level.
 */
export const functionNames = (items: RegistryItems): ReadonlyArray<string> =>
  pipe(
    Record.toEntries(items),
    Array.filter(([, value]) =>
      FunctionRegistryItem.isFunctionRegistryItem(value),
    ),
    Array.map(([name]) => name),
  );

/**
 * The keys of the middleware implementations registered into a group's registry
 * (stored under `middleware:<key>` entries by `MiddlewareImpl`).
 */
export const middlewareKeys = (items: RegistryItems): ReadonlyArray<string> =>
  pipe(
    Record.values(items),
    Array.filter(MiddlewareRegistryItem.isMiddlewareRegistryItem),
    Array.map((item) => item.middlewareSpec.key),
  );

export interface MissingMiddleware {
  readonly functionName: string;
  readonly middlewareKey: string;
}

export const missingRequired = (
  items: RegistryItems,
  required: ReadonlyArray<{ readonly key: string }>,
  groupPath = "",
): ReadonlyArray<MissingMiddleware> =>
  Object.entries(items)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([functionName, value]) =>
      FunctionRegistryItem.isFunctionRegistryItem(value)
        ? required.flatMap(({ key }) =>
            value._tag === "Confect" &&
            value.middlewareAttachments.some(({ spec }) => spec.key === key)
              ? []
              : [
                  {
                    functionName:
                      groupPath === ""
                        ? functionName
                        : `${groupPath}.${functionName}`,
                    middlewareKey: key,
                  },
                ],
          )
        : [],
    );
