/**
 * Marks a source read from a real file, which `Sources.fromFiles` and the
 * generated test registry give, rather than one a test wrote by hand. The
 * generated registry, which imports nothing from `@confect/test`, sets the same
 * key with `Symbol.for`.
 */
const FILE_READ = Symbol.for("@confect/kernel/fileSource");

/**
 * `read`, marked as read from a real file. The kernel leaves a module whose
 * file-read source Convex would not register unregistered, as Convex leaves
 * such a file out.
 */
export const markFileRead = (
  read: () => Promise<string>,
): (() => Promise<string>) =>
  Object.assign(() => read(), { [FILE_READ]: true });

/**
 * Whether `read` is marked as read from a real file ({@link markFileRead}).
 */
export const isFileRead = (read: () => Promise<string>): boolean =>
  (read as unknown as Readonly<Record<symbol, unknown>>)[FILE_READ] === true;
