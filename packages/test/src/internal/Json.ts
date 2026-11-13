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
