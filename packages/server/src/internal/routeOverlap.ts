import * as Array from "effect/Array";
import { pipe } from "effect/Function";
import * as Str from "effect/String";

/**
 * A path pattern as a list of segments, read loosely enough that two patterns
 * which could match one request always overlap. A segment the reading cannot
 * pin down matches any one segment, or the rest of the path.
 */
type Segment =
  | { readonly _tag: "Literal"; readonly text: string }
  | { readonly _tag: "One" }
  | { readonly _tag: "Rest" };

const one: Segment = { _tag: "One" };
const rest: Segment = { _tag: "Rest" };

// Matching folds case and decodes, so a literal compares lowercased and an
// encoded one may be anything.
const literal = (text: string): Segment =>
  pipe(text, Str.includes("%"))
    ? one
    : { _tag: "Literal", text: pipe(text, Str.toLowerCase) };

const segments = (path: string): ReadonlyArray<string> =>
  Array.filter(pipe(path, Str.split("/")), (segment) => segment !== "");

/**
 * An Effect router path: `:name` parameters, regexes, optional parameters and
 * wildcards.
 */
export const effectPattern = (path: string): ReadonlyArray<Segment> => {
  const pattern: Array<Segment> = [];
  for (const segment of segments(path)) {
    if (
      pipe(segment, Str.includes("*")) ||
      pipe(segment, Str.includes("(")) ||
      pipe(segment, Str.endsWith("?"))
    ) {
      pattern.push(rest);
      return pattern;
    }
    pattern.push(pipe(segment, Str.includes(":")) ? one : literal(segment));
  }
  return pattern;
};

/**
 * A plain Convex route: an exact path, or a prefix that matches any path
 * starting with it.
 */
export const convexPattern = (
  route: { readonly path: string } | { readonly pathPrefix: string },
): ReadonlyArray<Segment> =>
  "path" in route
    ? Array.map(segments(route.path), literal)
    : [
        ...Array.map(
          segments(pipe(route.pathPrefix, Str.replace(/[^/]*$/, ""))),
          literal,
        ),
        rest,
      ];

/**
 * Whether some request path matches both patterns.
 */
export const overlap = (
  a: ReadonlyArray<Segment>,
  b: ReadonlyArray<Segment>,
): boolean => {
  const [first, second] = [a[0], b[0]];
  if (first?._tag === "Rest" || second?._tag === "Rest") return true;
  if (first === undefined || second === undefined) {
    return first === second;
  }
  if (
    first._tag === "Literal" &&
    second._tag === "Literal" &&
    first.text !== second.text
  ) {
    return false;
  }
  return overlap(a.slice(1), b.slice(1));
};
