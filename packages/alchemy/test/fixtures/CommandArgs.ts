import * as Arr from "effect/Array";
import type * as ChildProcess from "effect/process/ChildProcess";
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

/**
 * A command's environment variable, revealed if redacted; `undefined` when the
 * command leaves it unset.
 *
 * @stability unstable
 */
export const env = (
  command: { readonly options: ChildProcess.CommandOptions },
  name: string,
): string | undefined => {
  const value = command.options.env?.[name];
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
};
