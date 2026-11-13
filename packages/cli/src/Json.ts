/**
 * JSON text for a value. Generated source takes its string literals and the
 * manifest's body from here, so quoting and escaping follow one rule.
 */
export const stringify = (value: unknown, space?: number): string =>
  // oxlint-disable-next-line effecttsgo/global-json -- JSON's syntax and escaping are what generated source needs, and the CLI passes only JSON data, which always serializes.
  JSON.stringify(value, null, space);

/**
 * A JavaScript string literal for `value`.
 */
export const quote = (value: string): string => stringify(value);
