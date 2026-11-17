import * as Rec from "effect/Record";
import { markFileRead } from "./internal/FileSources.js";

/**
 * Module sources the test kernel reads each module's `"use node"` directive
 * from, keyed as the modules are.
 */
export type Sources = Readonly<Record<string, () => Promise<string>>>;

/**
 * Sources read from real files, such as a `?raw` glob of a component's modules
 * gives:
 *
 * ```ts
 * Sources.fromFiles(
 *   import.meta.glob("./component/**\/*.ts", {
 *     query: "?raw",
 *     import: "default",
 *   }),
 * );
 * ```
 *
 * A source passed raw is the text of the module its loader loads, so the kernel
 * refuses a `.ts` or `.tsx` one with no line starting with `import` or
 * `export`, such as a placeholder `""`, with `ModuleRuntime` reason
 * `placeholderSource`. One read from a file through `fromFiles` is instead a
 * file Convex's bundler would leave out, so the kernel leaves its module
 * unregistered, as a deployment does. Pass these to `registerComponent`'s
 * `sources` or a layer's `sources`.
 */
export const fromFiles = (sources: Sources): Sources =>
  Rec.map(sources, markFileRead);
