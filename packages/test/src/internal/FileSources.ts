import * as Rec from "effect/Record";

/**
 * The sources read from real files: those `Sources.fromFiles` returns, the
 * generated registry's, and the packaged reads. Module-private, so no reader a
 * test writes can claim to be one. A source from another loaded copy of
 * `@confect/test` is not a member either, so it is held to the strict rule,
 * which refuses loudly (#159).
 */
const fileReads = new WeakSet<() => Promise<string>>();

/**
 * `read`, marked as read from a real file. The kernel leaves a module whose
 * file-read source Convex would not register unregistered, as Convex leaves
 * such a file out.
 */
export const markFileRead = (
  read: () => Promise<string>,
): (() => Promise<string>) => {
  const marked = () => read();
  fileReads.add(marked);
  return marked;
};

/**
 * Each of `sources`, marked as read from a real file ({@link markFileRead}).
 */
export const markAllFileRead = (
  sources: Readonly<Record<string, () => Promise<string>>>,
): Record<string, () => Promise<string>> => Rec.map(sources, markFileRead);

/**
 * Whether `read` was marked as read from a real file ({@link markFileRead}).
 */
export const isFileRead = (read: () => Promise<string>): boolean =>
  fileReads.has(read);
