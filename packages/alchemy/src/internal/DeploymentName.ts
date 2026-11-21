import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

const name = "[a-z0-9]+(?:-[a-z0-9]+)*";

/**
 * Whether `value` is a Convex deployment name, such as `happy-otter-123`.
 */
export const isName = (value: string) => new RegExp(`^${name}$`).test(value);

/**
 * The deployment a cloud deploy key names in its prefix, as in
 * `prod:happy-otter-123|...`; none for any other shape.
 */
export const ofDeployKey = (key: string): Option.Option<string> => {
  const match = new RegExp(
    `^(?:dev|prod|preview|custom):(${name})\\|[a-zA-Z0-9+/=_-]+$`,
  ).exec(key);
  return match === null ? Option.none() : Option.some(match[1]!);
};

/**
 * The deployment a Convex cloud URL names, as in
 * `https://happy-otter-123.eu-west-1.convex.cloud`; none for any other URL.
 */
export const ofCloudUrl = (url: string): Option.Option<string> => {
  const match = new RegExp(
    `^https://(${name})(?:\\.[a-z]{2}-[a-z]+-[0-9]+)?\\.convex\\.cloud/?$`,
  ).exec(url);
  return match === null ? Option.none() : Option.some(match[1]!);
};

/**
 * Whether a listed deploy key carries the name it was created with. Convex may
 * add a ` (<8 hex digits>)` suffix to keep listed names unique.
 */
export const isKeyNamed = (listed: string, requested: string) =>
  listed === requested ||
  (pipe(listed, Str.startsWith(`${requested} (`)) &&
    /^[0-9a-f]{8}\)$/.test(pipe(listed, Str.slice(requested.length + 2))));
