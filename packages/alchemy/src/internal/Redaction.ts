import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Buffer } from "node:buffer";

/**
 * What a redacted credential reads as.
 */
export const redaction = "<REDACTED>";

// Short needles match common diagnostic text rather than useful credentials.
const minimumCredentialLength = 8;

const escape = Str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const encodings = (value: string): ReadonlyArray<string> => {
  const bytes = Buffer.from(value);
  return Arr.flatMap(["base64", "base64url"] as const, (encoding) => [
    Str.replace(/=+$/, "")(bytes.toString(encoding)),
    ...Arr.map([0, 1, 2], (offset) =>
      // The first and last partial sextets depend on bytes outside the key.
      Str.slice(
        Math.ceil((offset * 8) / 6),
        Math.floor(((offset + bytes.length) * 8) / 6),
      )(Buffer.concat([Buffer.alloc(offset), bytes]).toString(encoding)),
    ),
  ]);
};

const percentEncoded = (value: string) =>
  Arr.join(
    Arr.map(Str.split(/(%[0-9A-F]{2})/)(encodeURIComponent(value)), (part) =>
      Str.startsWith("%")(part)
        ? Arr.join(
            Arr.map(Str.split("")(part), (char) =>
              /[A-F]/.test(char) ? `[${char}${Str.toLowerCase(char)}]` : char,
            ),
            "",
          )
        : escape(part),
    ),
    "",
  );

/**
 * Replace every Convex deploy key, and each of `secrets` as written,
 * base64-encoded or percent-encoded, with {@link redaction}. Secrets shorter
 * than eight characters are left alone.
 *
 * @internal
 */
export const redact = (text: string, secrets: ReadonlyArray<string>) => {
  const credentials = Arr.filter(
    secrets,
    (value) => value.length >= minimumCredentialLength,
  );
  const pattern = new RegExp(
    Arr.join(
      [
        "(?:prod|dev|preview|project|custom):[^\\s|]+\\|[^\\s\\\\\"'&)]+",
        ...Arr.map(credentials, percentEncoded),
        ...Arr.map(
          Arr.flatMap(credentials, (value) => [value, ...encodings(value)]),
          escape,
        ),
      ],
      "|",
    ),
    "g",
  );
  return Str.replace(pattern, redaction)(text);
};
