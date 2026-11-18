import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

/**
 * The extensions Convex's bundler takes an entry point from
 * (`ENTRY_POINT_EXTENSIONS`, `convex` 1.49 `src/bundler/index.ts:390-402`).
 */
const extensions = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".jsx",
];

const baseOf = (file: string) =>
  Option.match(Str.lastIndexOf("/")(file), {
    onNone: () => file,
    onSome: (at) => pipe(file, Str.slice(at + 1)),
  });

/**
 * Whether Convex's bundler registers the file at `file`, a `/`-separated path
 * below a Convex directory, by its name alone. This is the first half of the
 * one rule `entryPoints` applies (`convex` 1.49
 * `src/bundler/index.ts:405-484`): a JavaScript or TypeScript extension,
 * outside `_generated`, not a dotfile or an editor's `#` file, at most one dot
 * in the name and no space in the path. A schema passes; the bundler deploys it
 * beside the modules. A file that passes and {@link needsSource} is registered
 * only when {@link admitsSource} also passes.
 */
export const admitsName = (file: string): boolean => {
  const base = baseOf(file);
  return (
    Arr.some(extensions, (extension) => pipe(file, Str.endsWith(extension))) &&
    !pipe(file, Str.startsWith("_generated/")) &&
    !pipe(base, Str.startsWith(".")) &&
    !pipe(base, Str.startsWith("#")) &&
    pipe(
      base,
      Str.match(/\./g),
      Option.match({ onNone: () => 0, onSome: (dots) => dots.length }),
    ) <= 1 &&
    !pipe(file, Str.includes(" "))
  );
};

/**
 * Whether the bundler reads the file's text before it registers it: a `.ts` or
 * `.tsx` file (`src/bundler/index.ts:486-499`).
 */
export const needsSource = (file: string): boolean =>
  pipe(file, Str.endsWith(".ts")) || pipe(file, Str.endsWith(".tsx"));

/**
 * The second half of the rule: a file that {@link needsSource} is registered
 * only when a line starts with `import` or `export`, after at most 100
 * whitespace characters, as TypeScript needs of a module
 * (`src/bundler/index.ts:486-499`). Any other file passes.
 */
export const admitsSource = (file: string, source: string): boolean =>
  !needsSource(file) || /^\s{0,100}(?:import|export)/m.test(source);

/**
 * The one rule, both halves: whether Convex's bundler registers `file`, whose
 * text is `source`.
 */
export const admits = (file: string, source: string): boolean =>
  admitsName(file) && admitsSource(file, source);

/**
 * Whether the file at `file` is named as a schema, which the bundler deploys
 * apart from the function modules wherever it sits
 * (`src/bundler/index.ts:466-467`).
 */
export const isSchema = (file: string): boolean =>
  baseOf(file) === "schema.ts" || baseOf(file) === "schema.js";
