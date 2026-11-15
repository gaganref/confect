// oxlint-disable-next-line effecttsgo/node-builtin-import -- The Windows case resolves an entry through Node's win32 path API, which only node:path has.
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { plugin } from "@confect/test/Vite";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as PackageDirectory from "../src/internal/PackageDirectory";

const fixtures = new URL("./fixtures/mountImports/", import.meta.url).pathname;

// The same directory as a platform path, written with `/` as Vite writes ids.
const directoryOf = (name: string) =>
  pipe(
    fileURLToPath(new URL(`./fixtures/mountImports/${name}`, import.meta.url)),
    Str.replaceAll("\\", "/"),
  );

/**
 * One mount's copy of a fixture module, loaded as generated `testing.ts` loads
 * a mount's module.
 */
const copy = <A>(module: string, mount: string) =>
  Effect.promise(
    () =>
      import(
        /* @vite-ignore */ `${fixtures}component/convex/${module}.js?confect-mount=${encodeURIComponent(mount)}`
      ) as Promise<A>,
  );

interface Json {
  readonly objects: {
    readonly inside: { value: number };
    readonly outside: { value: number };
  };
}

interface Assets {
  readonly values: {
    readonly logo: string;
    readonly text: string;
    readonly url: string;
    readonly wasm: unknown;
  };
}

type ResolveId = (
  this: {
    readonly resolve: () => Promise<{ readonly id: string; external: false }>;
  },
  source: string,
  importer: string,
  options: object,
) => Promise<{ readonly id: string } | null>;

/**
 * The id the plugin gives a module a tagged one imports, when the import
 * resolves to `resolved`.
 */
const tagged = (built: ReturnType<typeof plugin>, resolved: string) =>
  Effect.promise(() =>
    (built.resolveId as unknown as ResolveId).call(
      { resolve: () => Promise.resolve({ id: resolved, external: false }) },
      "./module.ts",
      "/app/component/convex/importer.ts?confect-mount=first",
      {},
    ),
  );

describe("the Vite plugin", () => {
  it.effect(
    "gives each mount its own JSON object, from inside the component's folder and outside it",
    () =>
      Effect.gen(function* () {
        const first = yield* copy<Json>("json", "json-first");
        const second = yield* copy<Json>("json", "json-second");
        first.objects.inside.value = 1;
        first.objects.outside.value = 1;
        expect(second.objects).toEqual({
          inside: { value: 0 },
          outside: { value: 0 },
        });
        expect(first.objects.inside).not.toBe(second.objects.inside);
        expect(first.objects.outside).not.toBe(second.objects.outside);
      }),
  );

  it.effect(
    "shares one copy of an asset, WASM and a raw or URL import across mounts, untagged",
    () =>
      Effect.gen(function* () {
        const first = yield* copy<Assets>("assets", "assets-first");
        const second = yield* copy<Assets>("assets", "assets-second");
        expect(first.values.text).toBe("hello\n");
        expect(first.values.wasm).toBeTypeOf("function");
        expect(second.values).toEqual(first.values);
        expect(second.values.wasm).toBe(first.values.wasm);
        for (const url of [first.values.logo, first.values.url])
          expect(pipe(url, Str.includes("confect-mount"))).toBe(false);
      }),
  );

  it.effect(
    "keeps a package directory's files one copy, written with or without a trailing separator",
    () =>
      Effect.gen(function* () {
        const directory = directoryOf("component");
        const inside = `${directory}/module.ts`;
        for (const entry of [directory, `${directory}/`]) {
          const shared = yield* tagged(plugin({ packages: [entry] }), inside);
          expect(shared).toEqual({ id: inside, external: false });
        }
        const copied = yield* tagged(plugin(), inside);
        expect(copied).toEqual({
          id: `${inside}?confect-mount=first`,
          external: false,
        });
      }),
  );

  it("reads a Windows entry with a trailing backslash as its directory", () => {
    expect(
      PackageDirectory.normalize(
        "C:\\repo\\packages\\core\\src\\",
        NodePath.win32,
      ),
    ).toBe("C:/repo/packages/core/src");
  });

  it("refuses a packages entry that is missing or not a directory, naming it", () => {
    const missing = directoryOf("missing");
    const file = directoryOf("outside.json");
    expect(() => plugin({ packages: [missing] })).toThrow(
      `the packages entry ${missing} is not a directory`,
    );
    expect(() => plugin({ packages: [file] })).toThrow(
      `the packages entry ${file} is not a directory`,
    );
  });
});
