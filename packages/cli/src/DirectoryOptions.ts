import { IdScope } from "@confect/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import * as Flag from "effect/cli/Flag";
import * as ComponentDefinition from "./ComponentDefinition.js";
import * as ConfectDirectory from "./ConfectDirectory.js";
import * as ConvexDirectory from "./ConvexDirectory.js";
import * as ProjectRoot from "./ProjectRoot.js";

/**
 * @internal
 */
export const flags = {
  componentDir: Flag.String("component-dir").pipe(
    Flag.withDescription(
      "Generate a component instead of the application; its sibling confect/ directory contains the source.",
    ),
    Flag.optional,
  ),
};

export const layer = ({
  componentDir,
}: {
  componentDir: Option.Option<string>;
}) => {
  const projectRootLayer = Option.match(componentDir, {
    onNone: () => ProjectRoot.layer,
    onSome: (directory) =>
      Layer.effect(
        ProjectRoot.ProjectRoot,
        Effect.map(ProjectRoot.findProjectRootFrom(directory), (root) =>
          ProjectRoot.ProjectRoot.of({
            get: Effect.succeed(root),
          }),
        ),
      ),
  });
  const convex: Layer.Layer<
    ConvexDirectory.ConvexDirectory,
    Layer.Error<typeof ConvexDirectory.layer> | Schema.SchemaError,
    FileSystem.FileSystem | Path.Path
  > = Option.match(componentDir, {
    onNone: () => ConvexDirectory.layer,
    onSome: (directory) =>
      Layer.effect(
        ConvexDirectory.ConvexDirectory,
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const absolute = path.resolve(directory);
          // A declared component's `convex.config.ts` is codegen output, so
          // its sibling `confect/app.ts` also marks the directory.
          if (
            !(yield* fs.exists(path.join(absolute, "convex.config.ts"))) &&
            !(yield* fs.exists(
              path.join(path.dirname(absolute), "confect", "app.ts"),
            ))
          ) {
            return yield* ConvexDirectory.ConvexDirectoryNotFoundError.make({});
          }
          const definition = yield* ComponentDefinition.of(absolute);
          return ConvexDirectory.ConvexDirectory.of({
            get: Effect.succeed(absolute),
            target: {
              kind: "component",
              scope: IdScope.component(definition),
            },
          });
        }),
      ),
  });
  return Layer.mergeAll(
    projectRootLayer,
    ConfectDirectory.layerFromConvexDirectory.pipe(Layer.provideMerge(convex)),
  );
};
