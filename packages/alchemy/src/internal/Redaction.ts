import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
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
 * Every form in which a credential can reach text: the credential without an
 * `Authorization` scheme, and the token after each of its `|`. A deploy key
 * `dev:<deployment>|<login>` wraps a login, and a login such as
 * `project:<team>:<project>|<token>` wraps its token, so either may be echoed
 * alone.
 *
 * @internal
 */
export const forms = (credential: string): ReadonlyArray<string> => {
  const parts = Str.split("|")(
    Str.replace(/^(?:Bearer|Convex) /, "")(credential),
  );
  return Arr.map(Arr.range(0, parts.length - 1), (index) =>
    Arr.join(Arr.drop(parts, index), "|"),
  );
};

/**
 * Replace every Convex credential shape, and each form of each of `secrets` as
 * written, base64-encoded or percent-encoded, with {@link redaction}. Forms
 * shorter than eight characters are left alone.
 *
 * @internal
 */
export const redact = (text: string, secrets: ReadonlyArray<string>) => {
  const credentials = Arr.filter(
    Arr.flatMap(secrets, forms),
    (value) => value.length >= minimumCredentialLength,
  );
  const pattern = new RegExp(
    Arr.join(
      [
        "(?:prod|dev|preview|project|custom|team):[^\\s|]+\\|[^\\s\\\\\"'&)]+",
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

/**
 * The credentials a run has handled: the management login, and every deploy key
 * or admin key it was supplied, obtained or sent. Each boundary that builds an
 * error, a span or a diagnostic from outside text redacts that text against the
 * whole set, so a credential one part of the run handled cannot surface through
 * another.
 *
 * @internal
 */
export class Credentials extends Context.Service<
  Credentials,
  {
    readonly add: (
      credential: Redacted.Redacted<string>,
    ) => Effect.Effect<void>;
    /**
     * `text` with every form of every credential added so far redacted.
     */
    readonly redact: (text: string) => string;
  }
>()("@confect/alchemy/internal/Redaction/Credentials") {}

const make = Effect.sync(() => {
  const known = new Set<string>();
  return Credentials.of({
    add: (credential) =>
      Effect.sync(() => void known.add(Redacted.value(credential))),
    redact: (text) => redact(text, [...known]),
  });
});

/**
 * One set for a whole run; `Convex.providers` provides it.
 *
 * @internal
 */
export const credentialsLayer = Layer.effect(Credentials, make);

/**
 * The run's set, or outside `Convex.providers` a set of the caller's own, so
 * each public layer still redacts what it handled itself.
 *
 * @internal
 */
export const credentials = Effect.serviceOption(Credentials).pipe(
  Effect.flatMap(Option.match({ onNone: () => make, onSome: Effect.succeed })),
);
