import { App, Auth, Env } from "@confect/core";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- a synchronous hash of in-memory strings in a pure function; Effect's Crypto is a service.
import { createHash } from "node:crypto";

/**
 * A backend's declaration (`confect/env.ts`, `app.ts`, `auth.ts`) reduced to
 * the plain data codegen renders. The evaluated modules are parsed into this
 * once, at {@link parse}; every renderer below is a pure function of it.
 */
export interface Declaration {
  readonly target: "app" | "component";
  readonly name: string;
  readonly env: ReadonlyArray<readonly [string, Env.Descriptor]>;
  readonly mounts: ReadonlyArray<Mount>;
  readonly providers: Option.Option<ReadonlyArray<Provider>>;
}

export interface Mount {
  readonly name: string;
  readonly importPath: string;
  readonly componentName: string;
  readonly httpPrefix: string | undefined;
  readonly env: ReadonlyArray<readonly [string, Binding]>;
}

export type Binding =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "env"; readonly key: string };

export type ProviderValue =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "siteUrl"; readonly path: string };

export type Provider = ReadonlyArray<readonly [string, ProviderValue]>;

export class NotADeclaration extends Data.TaggedError("NotADeclaration")<{
  readonly file: string;
  readonly expected: string;
}> {
  override get message(): string {
    return `${this.file} must default-export ${this.expected}.`;
  }
}

export class InvalidEnvKey extends Data.TaggedError("InvalidEnvKey")<{
  readonly key: string;
}> {
  override get message(): string {
    return `"${this.key}" is not a valid Convex environment variable name; use letters, digits and underscores, starting with a letter.`;
  }
}

export class InvalidMountName extends Data.TaggedError("InvalidMountName")<{
  readonly mount: string;
}> {
  override get message(): string {
    return `"${this.mount}" is not a valid mount name; use letters, digits and underscores, starting with a letter or underscore.`;
  }
}

export class ForeignEnvBinding extends Data.TaggedError("ForeignEnvBinding")<{
  readonly mount: string;
  readonly slot: string;
  readonly backend: string;
  readonly key: string;
  readonly expectedBackend: string;
}> {
  override get message(): string {
    return `The mount "${this.mount}" binds ${this.slot} to ${this.key} of the "${this.backend}" env, but this backend's env is "${this.expectedBackend}".`;
  }
}

export class InvalidBinding extends Data.TaggedError("InvalidBinding")<{
  readonly mount: string;
  readonly slot: string;
}> {
  override get message(): string {
    return `The mount "${this.mount}" binds ${this.slot} to something other than a string or an entry of this backend's env.`;
  }
}

export class UnknownComponentImport extends Data.TaggedError(
  "UnknownComponentImport",
)<{ readonly mount: string }> {
  override get message(): string {
    return `The mount "${this.mount}" must pass the default export of a component's convex.config module, imported directly in the declaration.`;
  }
}

export class AuthForAnotherBackend extends Data.TaggedError(
  "AuthForAnotherBackend",
)<{ readonly backend: string; readonly expectedBackend: string }> {
  override get message(): string {
    return `confect/auth.ts declares auth for the "${this.backend}" backend, but confect/app.ts declares "${this.expectedBackend}".`;
  }
}

export type DeclarationError =
  | NotADeclaration
  | InvalidEnvKey
  | InvalidMountName
  | ForeignEnvBinding
  | InvalidBinding
  | UnknownComponentImport
  | AuthForAnotherBackend;

const ENV_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const MOUNT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The declaration file a parse error is about.
 */
export const fileOf = (error: DeclarationError): string =>
  error._tag === "NotADeclaration"
    ? error.file
    : error._tag === "AuthForAnotherBackend"
      ? "confect/auth.ts"
      : "confect/app.ts";

/**
 * A mounted component's import as the generated `convex.config.ts` writes it.
 */
export interface ComponentImport {
  readonly importPath: string;
  readonly componentName: string;
}

/**
 * Parse the default exports of `confect/app.ts` and, when present,
 * `confect/auth.ts`. `componentImport` recovers how the generated config
 * imports a mounted definition; codegen's bundler records it.
 */
export const parse = (input: {
  readonly target: "app" | "component";
  readonly app: unknown;
  readonly auth: Option.Option<unknown>;
  readonly componentImport: (
    definition: unknown,
  ) => Option.Option<ComponentImport>;
}): Result.Result<Declaration, DeclarationError> =>
  Result.gen(function* () {
    if (!App.isApp(input.app)) {
      return yield* Result.fail(
        new NotADeclaration({
          file: "confect/app.ts",
          expected: "App.make(...)",
        }),
      );
    }
    const env = App.env(input.app);
    const name = Env.name(env);
    const descriptors = Env.descriptors(env);
    for (const [key] of descriptors) {
      if (!ENV_KEY.test(key))
        return yield* Result.fail(new InvalidEnvKey({ key }));
    }

    const mounts: Array<Mount> = [];
    for (const mount of App.mounts(input.app)) {
      if (!MOUNT_NAME.test(mount.name)) {
        return yield* Result.fail(new InvalidMountName({ mount: mount.name }));
      }
      const component = input.componentImport(mount.definition);
      if (Option.isNone(component)) {
        return yield* Result.fail(
          new UnknownComponentImport({ mount: mount.name }),
        );
      }
      const bindings: Array<readonly [string, Binding]> = [];
      for (const [slot, bound] of Object.entries(mount.env)) {
        if (bound === undefined) continue;
        if (typeof bound === "string") {
          bindings.push([slot, { kind: "value", value: bound }]);
          continue;
        }
        if (!Env.isEntry(bound)) {
          return yield* Result.fail(
            new InvalidBinding({ mount: mount.name, slot }),
          );
        }
        const origin = Env.origin(bound);
        if (origin.backend !== name) {
          return yield* Result.fail(
            new ForeignEnvBinding({
              mount: mount.name,
              slot,
              backend: origin.backend,
              key: origin.key,
              expectedBackend: name,
            }),
          );
        }
        bindings.push([slot, { kind: "env", key: origin.key }]);
      }
      mounts.push({
        name: mount.name,
        importPath: component.value.importPath,
        componentName: component.value.componentName,
        httpPrefix: mount.httpPrefix,
        env: bindings,
      });
    }

    const providers: Option.Option<ReadonlyArray<Provider>> = Option.isNone(
      input.auth,
    )
      ? Option.none()
      : Option.some(yield* parseProviders(input.auth.value, name));

    return {
      target: input.target,
      name,
      env: descriptors,
      mounts,
      providers,
    };
  });

const parseProviders = (
  auth: unknown,
  backend: string,
): Result.Result<ReadonlyArray<Provider>, DeclarationError> => {
  if (!Auth.isAuth(auth)) {
    return Result.fail(
      new NotADeclaration({
        file: "confect/auth.ts",
        expected: "Auth.make(app, ...)",
      }),
    );
  }
  const authBackend = Env.name(App.env(auth.app));
  if (authBackend !== backend) {
    return Result.fail(
      new AuthForAnotherBackend({
        backend: authBackend,
        expectedBackend: backend,
      }),
    );
  }
  return Result.succeed(
    Auth.providers(auth).map((provider) =>
      Object.entries(provider).map(([field, value]) => {
        const sitePath = Auth.siteUrlPath(value);
        return [
          field,
          sitePath === undefined
            ? {
                kind: "value",
                value: Predicate.isString(value)
                  ? value
                  : JSON.stringify(value),
              }
            : { kind: "siteUrl", path: sitePath },
        ] as const;
      }),
    ),
  );
};

const quote = (value: string): string => JSON.stringify(value);

export const header = (source: string): string =>
  `// Generated by \`confect codegen\` from ${source}. Do not edit.`;

const GENERATED_PREFIX = "// Generated by `confect codegen` from ";

/**
 * Whether codegen may overwrite or remove an existing file: it carries the
 * generated header, or it is exactly one of the files an earlier codegen wrote
 * there (`legacy`).
 */
export const isGenerated = (
  contents: string,
  legacy: ReadonlyArray<string>,
): boolean =>
  contents.startsWith(GENERATED_PREFIX) || legacy.includes(contents);

const validator = (descriptor: Env.Descriptor): string => {
  const base =
    descriptor.kind === "literals"
      ? descriptor.values.length === 1
        ? `v.literal(${quote(descriptor.values[0])})`
        : `v.union(${descriptor.values.map((value) => `v.literal(${quote(value)})`).join(", ")})`
      : "v.string()";
  return descriptor.optional ? `v.optional(${base})` : base;
};

const RESERVED = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(
    " ",
  ),
);

/**
 * A safe import name for a component, from its Convex name.
 */
const identifier = (name: string): string => {
  const cleaned = name.replaceAll(/[^A-Za-z0-9_$]/g, "_");
  const valid = /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return RESERVED.has(valid) ? `${valid}Component` : valid;
};

/**
 * `convex/convex.config.ts`: Convex's own app or component definition.
 */
export const convexConfig = (declaration: Declaration): string => {
  const self = declaration.target === "app" ? "app" : "component";
  const aliases = new Map<string, string>();
  const taken = new Set([self, "v", "defineApp", "defineComponent"]);
  for (const mount of declaration.mounts) {
    if (aliases.has(mount.importPath)) continue;
    const base = identifier(mount.componentName);
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}${n}`;
    taken.add(alias);
    aliases.set(mount.importPath, alias);
  }

  const lines = [header("confect/app.ts")];
  lines.push(
    declaration.target === "app"
      ? 'import { defineApp } from "convex/server";'
      : 'import { defineComponent } from "convex/server";',
  );
  if (declaration.env.length > 0)
    lines.push('import { v } from "convex/values";');
  for (const [importPath, alias] of aliases) {
    lines.push(`import ${alias} from ${quote(importPath)};`);
  }
  lines.push("");

  const envBlock =
    declaration.env.length === 0
      ? []
      : [
          "  env: {",
          ...declaration.env.map(
            ([key, descriptor]) => `    ${key}: ${validator(descriptor)},`,
          ),
          "  },",
        ];
  if (declaration.target === "app") {
    lines.push(
      envBlock.length === 0
        ? "const app = defineApp();"
        : ["const app = defineApp({", ...envBlock, "});"].join("\n"),
    );
  } else {
    lines.push(
      envBlock.length === 0
        ? `const component = defineComponent(${quote(declaration.name)});`
        : [
            `const component = defineComponent(${quote(declaration.name)}, {`,
            ...envBlock,
            "});",
          ].join("\n"),
    );
  }

  for (const mount of declaration.mounts) {
    lines.push("");
    lines.push(`${self}.use(${aliases.get(mount.importPath)}, {`);
    lines.push(`  name: ${quote(mount.name)},`);
    if (mount.httpPrefix !== undefined) {
      lines.push(`  httpPrefix: ${quote(mount.httpPrefix)},`);
    }
    if (mount.env.length > 0) {
      lines.push("  env: {");
      for (const [slot, binding] of mount.env) {
        lines.push(
          `    ${slot}: ${binding.kind === "value" ? quote(binding.value) : `${self}.env.${binding.key}`},`,
        );
      }
      lines.push("  },");
    }
    lines.push("});");
  }

  lines.push("", `export default ${self};`, "");
  return lines.join("\n");
};

const providerValue = (value: ProviderValue): string =>
  value.kind === "value"
    ? quote(value.value)
    : `\`\${process.env.CONVEX_SITE_URL}${value.path.replaceAll(/[`$\\]/g, "\\$&")}\``;

/**
 * `convex/auth.config.ts`: Convex's provider list, with site URLs resolved
 * there.
 */
export const authConfig = (providers: ReadonlyArray<Provider>): string =>
  [
    header("confect/auth.ts"),
    'import type { AuthConfig } from "convex/server";',
    "",
    "export default {",
    providers.length === 0 ? "  providers: []," : "  providers: [",
    ...(providers.length === 0
      ? []
      : [
          ...providers.flatMap((provider) => [
            "    {",
            ...provider.map(
              ([field, value]) => `      ${field}: ${providerValue(value)},`,
            ),
            "    },",
          ]),
          "  ],",
        ]),
    "} satisfies AuthConfig;",
    "",
  ].join("\n");

/**
 * `confect/_generated/manifest.ts`: plain data, no imports, for infra.
 */
export const manifest = (declaration: Declaration, digest: string): string => {
  const data = {
    name: declaration.name,
    env: Object.fromEntries(declaration.env),
    http: {
      mounts: Object.fromEntries(
        declaration.mounts.flatMap(({ name, httpPrefix }) =>
          httpPrefix === undefined ? [] : [[name, httpPrefix]],
        ),
      ),
    },
    digest,
  };
  return `${header("confect/env.ts and confect/app.ts")}\n\nexport default ${JSON.stringify(data, null, 2)} as const;\n`;
};

/**
 * A digest of the declaration's inputs: every first-party file its modules
 * import (by project-relative path and contents) and the versions of the
 * packages that shape the generated output.
 */
export const digest = (input: {
  readonly files: ReadonlyArray<readonly [string, string]>;
  readonly versions: ReadonlyArray<readonly [string, string]>;
}): string => {
  const hash = createHash("sha256");
  const byFirst = (
    a: readonly [string, string],
    b: readonly [string, string],
  ) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  hash.update(
    JSON.stringify({
      files: [...input.files].sort(byFirst),
      versions: [...input.versions].sort(byFirst),
    }),
  );
  return `sha256:${hash.digest("hex")}`;
};
