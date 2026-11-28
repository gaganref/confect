/**
 * Confect's check of a side that holds a secret against the binary's own: each
 * fixture pair differs only in whether `value` is a secret, so Convex checks
 * the plain twin and Confect the secret one. Both get the same calls over the
 * wire and must answer alike, and the secret twin's answer must hold no value.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import { stringify } from "../../../test/src/internal/Json";
import { makeFunctionReference } from "convex/server";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

const marker = "canary-secret-twin-0b3d";

const Answer = Schema.Struct({
  status: Schema.Literals(["success", "error"]),
  errorMessage: Schema.optionalKey(Schema.String),
  errorData: Schema.optionalKey(Schema.Unknown),
  value: Schema.optionalKey(Schema.Unknown),
});

/**
 * A mutation call as a client sends it, with `args` as its positional list.
 */
const call = (name: string, args: ReadonlyArray<unknown>) =>
  HttpClientRequest.post(`${LocalBackend.cloudUrl()}/api/mutation`).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      path: `groups/secretTwins:${name}`,
      format: "json",
      args,
    }),
    HttpClient.execute,
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Answer)),
  );

/**
 * Both twins' answers to the same call.
 */
const twins = (name: string, args: ReadonlyArray<unknown>) =>
  Effect.all({
    plain: call(`${name}Plain`, args),
    secret: call(`${name}Secret`, args),
  });

const printed = (answer: typeof Answer.Type) =>
  `${answer.errorMessage ?? ""}${stringify(answer.errorData ?? null)}`;

layer(Layer.mergeAll(LocalBackend.layer, FetchHttpClient.layer), {
  timeout: "120 seconds",
  excludeTestServices: true,
})("a secret twin against its plain twin on the binary", (it) => {
  it.effect("refuses more or fewer arguments than one, as Convex does", () =>
    Effect.gen(function* () {
      for (const args of [[{ value: marker }, { value: marker }], []]) {
        const { plain, secret } = yield* twins("count", args);
        const count = `Expected to receive a single object as the function's argument. Instead received ${args.length} arguments`;
        expect({
          plain: [plain.status, pipe(printed(plain), Str.includes(count))],
          secret: [secret.status, pipe(printed(secret), Str.includes(count))],
          secretPrints: pipe(printed(secret), Str.includes(marker)),
          secretData: secret.errorData,
        }).toEqual({
          plain: ["error", true],
          secret: ["error", true],
          secretPrints: false,
          secretData: {
            _tag: "@confect/server/SecretSideRefused",
            side: "arguments",
            path: "",
            validator: "v.object({value: v.string()})",
          },
        });
      }
    }),
  );

  it.effect("refuses a legacy ID string, as Convex's validator does", () =>
    Effect.gen(function* () {
      const { plain, secret } = yield* twins("id", [
        { row: "LZ_YyWnYaZSFKTnOpihMPA", value: marker },
      ]);
      expect({
        plain: plain.status,
        secret: secret.status,
        secretPrints: pipe(printed(secret), Str.includes(marker)),
        secretPath: pipe(printed(secret), Str.includes("Path: .row")),
      }).toEqual({
        plain: "error",
        secret: "error",
        secretPrints: false,
        secretPath: true,
      });
    }),
  );

  it.effect(
    "takes an optional field an object inherits but does not hold, as Convex does",
    () =>
      Effect.gen(function* () {
        const { plain, secret } = yield* twins("toString", [{}]);
        expect([plain.status, secret.status]).toEqual(["success", "success"]);
      }),
  );

  it.effect(
    "refuses a value the function's own schema refuses, and only the plain twin prints it",
    () =>
      Effect.gen(function* () {
        const { plain, secret } = yield* twins("token", [
          { payload: stringify({ token: marker }) },
        ]);
        expect({
          plain: [plain.status, pipe(printed(plain), Str.includes(marker))],
          secret: [secret.status, pipe(printed(secret), Str.includes(marker))],
          secretData: secret.errorData,
        }).toEqual({
          plain: ["error", true],
          secret: ["error", false],
          secretData: {
            _tag: "@confect/server/SecretSideRefused",
            side: "arguments",
            path: "",
            validator: "v.object({payload: v.string()})",
          },
        });
      }),
  );

  it.effect(
    "refuses a return Convex cannot serialize, and only the plain twin prints its value",
    () =>
      Effect.gen(function* () {
        const { plain, secret } = yield* twins("date", [{ value: marker }]);
        expect({
          plain: [plain.status, pipe(printed(plain), Str.includes(marker))],
          secret: [secret.status, pipe(printed(secret), Str.includes(marker))],
        }).toEqual({ plain: ["error", true], secret: ["error", false] });
      }),
  );
});

/**
 * A mutation call to the group of sides whose only secret is in their encoding.
 */
const encodedCall = (name: string, args: unknown) =>
  HttpClientRequest.post(`${LocalBackend.cloudUrl()}/api/mutation`).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      path: `groups/encodedSecrets:${name}`,
      format: "json",
      args: [args],
    }),
    HttpClient.execute,
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Answer)),
  );

layer(Layer.mergeAll(LocalBackend.layer, FetchHttpClient.layer), {
  timeout: "120 seconds",
  excludeTestServices: true,
})("a side whose only secret is in its encoding, on the binary", (it) => {
  it.effect.each([
    ["released", marker],
    ["struct", { token: marker }],
    ["midChain", marker],
    ["wireEnd", marker],
    ["record", { [marker]: "v" }],
  ] as const)(
    "%s: refuses an extra argument and an unserializable return without the value, and takes a valid call",
    ([name, value]) =>
      Effect.gen(function* () {
        const taken = yield* encodedCall(`${name}Take`, { value });
        const extra = yield* encodedCall(`${name}Take`, {
          value,
          note: "unexpected",
        });
        const given = yield* encodedCall(`${name}Give`, { value });
        expect({
          taken: taken.status,
          extra: [extra.status, pipe(printed(extra), Str.includes(marker))],
          extraData: extra.errorData,
          given: [given.status, pipe(printed(given), Str.includes(marker))],
          givenSide: (
            given.errorData as { readonly side?: unknown } | undefined
          )?.side,
        }).toEqual({
          taken: "success",
          extra: ["error", false],
          extraData: {
            _tag: "@confect/server/SecretSideRefused",
            side: "arguments",
            path: "",
            validator: expect.any(String),
          },
          given: ["error", false],
          givenSide: "returns",
        });
      }),
  );

  it.effect(
    "fails a scheduled call it refuses with a job error that holds no value",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const job = yield* Effect.promise(() =>
          client.mutation(
            makeFunctionReference<"mutation", { marker: string }, string>(
              "groups/encodedSecrets:scheduleRecordTake",
            ),
            { marker },
          ),
        );
        // The scheduler runs the job on its own; wait for it to fail.
        const state = yield* Effect.promise(() =>
          client.query(
            makeFunctionReference<
              "query",
              { id: string },
              { readonly kind: string; readonly error?: string }
            >("groups/encodedSecrets:jobState"),
            { id: job },
          ),
        ).pipe(
          Effect.filterOrFail(({ kind }) => kind === "failed"),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
        );
        expect({
          refused: pipe(
            state.error ?? "",
            Str.includes("ArgumentValidationError"),
          ),
          prints: pipe(state.error ?? "", Str.includes(marker)),
        }).toEqual({ refused: true, prints: false });
      }),
  );
});

const plainProbe = (field: string) => `
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
export const f = mutationGeneric({
  args: { ${stringify(field)}: v.string() },
  handler: async () => null,
});
`;

const secretProbe = (field: string) => `
import { FunctionSpec } from "@confect/core";
import { DatabaseSchema, FunctionRegistryItem, RegisteredConvexFunction } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const item = FunctionRegistryItem.make({
  functionSpec: FunctionSpec.publicMutation({
    name: "f",
    args: () => ({ ${stringify(field)}: Schema.RedactedFromValue(Schema.String) }),
    returns: () => Schema.Null,
  }),
  groupMiddlewareAttachments: [],
  handler: () => Effect.succeed(null),
});
if (item._tag !== "Confect") throw new Error("Expected a Confect function");
export const f = RegisteredConvexFunction.make(DatabaseSchema.make({}), item);
`;

/**
 * Write `source` as the declarations fixture's one function module and push it
 * to that fixture's own local deployment, with what the CLI printed.
 */
const push = (source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const directory = path.resolve(
      import.meta.dirname,
      "../../../../tools/local-backend/fixtures/declarations",
    );
    yield* fs.writeFileString(path.join(directory, "convex/probe.ts"), source);
    const port = LocalBackend.ports.declarations;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "pnpm",
        [
          "convex",
          "dev",
          "--once",
          "--typecheck=disable",
          "--codegen=disable",
          "--tail-logs=disable",
          "--local-cloud-port",
          String(port),
          "--local-site-port",
          String(port + 1),
          "--local-backend-version",
          "precompiled-2026-10-28-cccbade",
        ],
        {
          cwd: directory,
          extendEnv: true,
          env: { CONVEX_AGENT_MODE: "anonymous" },
        },
      ),
    );
    const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString);
    return { exitCode: yield* handle.exitCode, output };
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { timeout: "180 seconds" })(
  "a secret side's declaration at push",
  (it) => {
    it.effect(
      "is refused by the rule Convex refuses the same plain side's by",
      () =>
        Effect.gen(function* () {
          const rule =
            "Identifier a-b has invalid character '-': Identifiers can only contain alphanumeric characters or underscores";
          const plain = yield* push(plainProbe("a-b"));
          const secret = yield* push(secretProbe("a-b"));
          const valid = yield* push(secretProbe("ab"));
          expect({
            plain: [
              plain.exitCode === 0,
              pipe(plain.output, Str.includes(rule)),
            ],
            secret: [
              secret.exitCode === 0,
              pipe(
                secret.output,
                Str.includes(`Error in args validator: ${rule}`),
              ),
            ],
            valid: valid.exitCode,
          }).toEqual({
            plain: [false, true],
            secret: [false, true],
            valid: 0,
          });
        }),
    );
  },
);

layer(LocalBackend.plainLayer, { timeout: "300 seconds" })(
  "a pending commit timestamp",
  (it) => {
    it.effect(
      "is read by Confect's check as the binary reads it, in every validator kind",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const binary = (name: string) =>
            Effect.promise(() =>
              client
                .mutation(
                  makeFunctionReference<"mutation">(
                    `pendingProbe:binary${name}`,
                  ),
                  {},
                )
                .then(
                  () => true,
                  () => false,
                ),
            );
          const verdicts = {
            int64: yield* binary("Int64"),
            float64: yield* binary("Float64"),
            max: yield* binary("Max"),
            zero: yield* binary("Zero"),
            commitTs: yield* binary("CommitTs"),
            any: yield* binary("Any"),
          };
          const confect = yield* Effect.promise(() =>
            client.mutation(
              makeFunctionReference<"mutation">("pendingProbe:confect"),
              {},
            ),
          );
          expect({ binary: verdicts, confect }).toEqual({
            binary: {
              int64: true,
              float64: false,
              max: true,
              zero: false,
              commitTs: true,
              any: true,
            },
            confect: verdicts,
          });
        }),
    );
  },
);
