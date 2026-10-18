import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Convex } from "@confect/alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { apply } from "alchemy/Apply";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { fakeBackend } from "../fixtures/LocalBackend";

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "confect-local-deployment-",
  });
  const cwd = path.join(root, "backend");
  for (const [name, bin] of [
    ["convex", "convex"],
    ["@confect/cli", "confect"],
  ] as const) {
    const directory = path.join(cwd, "node_modules", name);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, "package.json"),
      `{"name":"${name}","bin":{"${bin}":"cli.js"}}`,
    );
  }
  return {
    cwd,
    dotAlchemy: path.join(root, ".alchemy"),
    home: path.join(root, "home"),
  };
});

/**
 * Runs `alchemy dev` sessions in-process: each session builds the providers
 * once and applies the stack `applies` times, the way a dev session re-applies
 * on change, then ends, closing the local provider's scope.
 */
const makeSession = (paths: {
  readonly dotAlchemy: string;
  readonly home: string;
}) => {
  const fake = fakeBackend();
  const state = inMemoryState();
  const context = Layer.mergeAll(
    Layer.mergeAll(
      CredentialsStoreLive,
      ProfileStoreLive,
      layerNonInteractive(),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
    Layer.succeed(Stage, "dev"),
    Layer.succeed(AuthProviders, {}),
    Layer.succeed(AlchemyContext, {
      dotAlchemy: paths.dotAlchemy,
      dev: true,
      adopt: false,
    }),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        HOME: paths.home,
        LOCALAPPDATA: paths.home,
        CONFECT_LOCAL_BACKEND_PORTS: "3360-3369",
      }),
    ),
  );
  const session = <A, E, R extends Convex.Providers | Stack.StackServices>(
    program: Effect.Effect<A, E, R>,
    applies = 1,
  ) =>
    program.pipe(
      Stack.make({ name: "notes", providers: Convex.providers(), state }),
      Effect.flatMap((compiled) =>
        Effect.forEach(Array.from({ length: applies }), () =>
          Plan.make(compiled).pipe(Effect.flatMap(apply)),
        ).pipe(Effect.provideContext(compiled.services)),
      ),
      Effect.provide(state),
      provideFreshArtifactStore,
      Effect.provide(fake.layer.pipe(Layer.provideMerge(context))),
      Effect.scoped,
    );
  return { fake, session };
};

const stack = (cwd: string, removal: "retain" | "destroy") =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("Project", {
      teamId: 10,
      name: "notes",
    });
    const deployment = yield* Convex.Deployment("Deployment", {
      projectId: project.projectId,
      type: "prod",
    }).pipe(
      removal === "destroy" ? RemovalPolicy.destroy() : RemovalPolicy.retain(),
    );
    const key = yield* Convex.DeployKey("Key", {
      deploymentName: deployment.name,
    });
    const code = yield* Convex.Code("Code", {
      deployment,
      deployKey: key.deployKey,
      cwd,
    });
    return { name: code.name, url: code.url };
  });

describe("local deployment lifecycle", () => {
  it.live(
    "boots once per session, restarts on its saved data, and removes data only when destroyed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const paths = yield* workspace;
        const { fake, session } = makeSession(paths);

        const [first, again] = yield* session(stack(paths.cwd, "destroy"), 2);
        expect(again).toEqual(first);
        expect(first?.url).toMatch(/^http:\/\/127\.0\.0\.1:336\d$/);
        expect(fake.served).toHaveLength(1);
        expect(fake.served[0]?.running()).toBe(false);
        const selection = `CONVEX_SELF_HOSTED_URL=${first?.url}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${first?.name}|0a1b2c1\n`;
        expect(fake.pushes).toEqual([selection, selection]);
        const data = path.join(
          paths.dotAlchemy,
          "convex",
          "notes",
          "dev",
          first?.name ?? "",
        );
        expect(yield* fs.exists(path.join(data, "identity.json"))).toBe(true);

        const [restarted] = yield* session(stack(paths.cwd, "destroy"));
        expect(restarted).toEqual(first);
        expect(fake.served).toHaveLength(2);
        expect(fake.pushes.at(-1)).toBe(selection);

        yield* session(Effect.succeed({}));
        expect(yield* fs.exists(data)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps a retained deployment's data after it leaves the stack", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const paths = yield* workspace;
      const { session } = makeSession(paths);
      const [created] = yield* session(stack(paths.cwd, "retain"));
      yield* session(Effect.succeed({}));
      expect(
        yield* fs.exists(
          path.join(
            paths.dotAlchemy,
            "convex",
            "notes",
            "dev",
            created?.name ?? "",
            "identity.json",
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
