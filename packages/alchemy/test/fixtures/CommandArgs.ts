import * as Arr from "effect/Array";
import type * as CommandLine from "effect/process/CommandLine";
import * as Redacted from "effect/Redacted";

/**
 * The words of a command line, with redacted words revealed.
 *
 * @stability unstable
 */
export const plain = (
  words: ReadonlyArray<CommandLine.Word>,
): ReadonlyArray<string> =>
  Arr.map(words, (word) =>
    Redacted.isRedacted(word) ? Redacted.value(word) : word,
  );
