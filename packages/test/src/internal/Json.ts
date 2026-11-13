import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";

/**
 * JSON for the kernel. Convex's server library reaches the backend through
 * syscalls that carry JSON strings, and the kernel answers them synchronously,
 * as the binary does. Its messages, keys and snapshot bytes are JSON text too,
 * so the kernel's JSON runs here, outside an Effect.
 */

/**
 * JSON text for `value`.
 */
export const stringify = (value: unknown): string =>
  // oxlint-disable-next-line effecttsgo/global-json -- The kernel writes Convex's syscall JSON and its own JSON text synchronously, outside an Effect.
  JSON.stringify(value);

/**
 * The value `text` holds.
 */
export const parse = (text: string): any =>
  // oxlint-disable-next-line effecttsgo/global-json -- The kernel reads Convex's syscall JSON and its own JSON text synchronously, outside an Effect; a caller that can meet bad text catches the throw.
  JSON.parse(text);

/**
 * `value` with every object's keys in order, so equal values written in any key
 * order give the same JSON text.
 */
export const canonical = (value: unknown): unknown =>
  Arr.isArray(value)
    ? Arr.map(value, canonical)
    : value !== null && typeof value === "object"
      ? Rec.fromEntries(
          Arr.map(
            Arr.sort(Rec.keys(value as Record<string, unknown>), Order.String),
            (key) => [key, canonical((value as Record<string, unknown>)[key])],
          ),
        )
      : value;
