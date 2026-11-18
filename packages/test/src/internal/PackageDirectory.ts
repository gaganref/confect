import * as Str from "effect/String";
import { pipe } from "effect/Function";

/**
 * The part of the platform's path API a package directory needs.
 */
export interface Paths {
  readonly resolve: (...segments: ReadonlyArray<string>) => string;
}

/**
 * A `packages` entry as the prefix of the Vite ids under it: resolved, so a
 * relative entry or a trailing separator names the same directory, then written
 * with `/`, as Vite writes ids on every platform.
 */
export const normalize = (entry: string, paths: Paths): string =>
  pipe(paths.resolve(entry), Str.replaceAll("\\", "/"));
