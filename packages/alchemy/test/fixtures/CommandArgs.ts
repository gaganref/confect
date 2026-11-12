import type * as CommandLine from "effect/process/CommandLine";
import * as Redacted from "effect/Redacted";

export const plain = (
  words: ReadonlyArray<CommandLine.Word>,
): ReadonlyArray<string> =>
  words.map((word) =>
    Redacted.isRedacted(word) ? Redacted.value(word) : word,
  );
