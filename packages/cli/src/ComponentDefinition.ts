import { parse as parseAST } from "@babel/parser";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { confectDirectoryOf } from "./ConfectDirectory.js";
import * as ProjectRoot from "./ProjectRoot.js";

const PackageName = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String }),
);

/**
 * The name a Confect component's ID scope gives its convex directory: `<package
 * name>:<directory relative to the package, with / separators>`. Component
 * codegen records it in `confect/_generated/id.ts`, and a host's registry
 * compares a mount's definition directory with it, so both compute it here.
 *
 * @internal
 */
export const of = Effect.fnUntraced(function* (convexDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectRoot = yield* ProjectRoot.findProjectRootFrom(convexDirectory);
  const pkg = yield* fs
    .readFileString(path.join(projectRoot, "package.json"))
    .pipe(Effect.flatMap(Schema.decodeEffect(PackageName)));
  const relative = path.relative(projectRoot, path.resolve(convexDirectory));
  return `${pkg.name}:${Array.join(pipe(relative, String.split(path.sep)), "/")}`;
});

/**
 * The convex directory a component's `confect/_generated/id.ts` records, read
 * from its `export const scope = IdScope.component("...")` declaration. The
 * file is parsed, so quote style, semicolons, line endings and comments do not
 * change the answer. None for an app's `id.ts`, for one written before the
 * scope line existed, and for text that does not parse.
 *
 * @internal
 */
export const recordedIn = (idSource: string): Option.Option<string> =>
  pipe(
    Option.liftThrowable(() =>
      parseAST(idSource, { sourceType: "module", plugins: ["typescript"] }),
    )(),
    Option.flatMap((file) =>
      Array.findFirst(file.program.body, (statement) => {
        if (
          statement.type !== "ExportNamedDeclaration" ||
          statement.declaration?.type !== "VariableDeclaration"
        )
          return Option.none();
        return Array.findFirst(
          statement.declaration.declarations,
          ({ id, init }) =>
            id.type === "Identifier" &&
            id.name === "scope" &&
            init?.type === "CallExpression" &&
            init.callee.type === "MemberExpression" &&
            init.callee.object.type === "Identifier" &&
            init.callee.object.name === "IdScope" &&
            init.callee.property.type === "Identifier" &&
            init.callee.property.name === "component" &&
            init.arguments.length === 1 &&
            init.arguments[0]?.type === "StringLiteral"
              ? Option.some(init.arguments[0].value)
              : Option.none(),
        );
      }),
    ),
  );

/**
 * The convex directory recorded by the `confect/_generated/id.ts` beside
 * `convexDirectory`, if that file exists and records one.
 *
 * @internal
 */
export const recordedBeside = Effect.fnUntraced(function* (
  convexDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const id = path.join(
    confectDirectoryOf(path, convexDirectory),
    "_generated",
    "id.ts",
  );
  if (!(yield* fs.exists(id))) return Option.none<string>();
  const source = yield* fs.readFileString(id);
  return recordedIn(source);
});
