import { createRequire } from "node:module";
import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  consumerDependencies,
  Manifest,
  profiles,
} from "./consumerCompatibility";

const require = createRequire(import.meta.url);
const repository = new URL("../", import.meta.url).pathname;

const readManifest = (path: string): Manifest =>
  Schema.decodeUnknownEffect(Manifest)(require(path)).pipe(Effect.runSync);
const isPrivate = Schema.is(Schema.Struct({ private: Schema.Literal(true) }));

const published = Arr.getSomes(
  Arr.map(
    Arr.fromIterable(
      new Bun.Glob("packages/*/package.json").scanSync({ cwd: repository }),
    ),
    (file) => {
      const path = `${repository}${file}`;
      return isPrivate(require(path))
        ? Option.none()
        : Option.some({
            directory: `${repository}${Str.replace("package.json", "")(file)}`,
            manifest: readManifest(path),
          });
    },
  ),
);
const byName = new Map(
  Arr.map(published, (entry) => [entry.manifest.name, entry]),
);

const semver: Order.Order<string> = (left, right) =>
  Bun.semver.order(left, right);

const floor = (range: string): string => {
  const match = /^(?:\^|~|>=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range);
  if (match?.[1] === undefined)
    throw new Error(`No single floor in the range ${range}`);
  return match[1];
};

const effectFloor = (manifest: Manifest): Option.Option<string> =>
  Option.map(
    Option.fromUndefinedOr(
      manifest.peerDependencies?.effect ?? manifest.dependencies?.effect,
    ),
    floor,
  );

// A package needs every Effect floor among its dependencies and required
// peers, as resolved in this workspace. A sibling @confect/* package counts
// with its own advertised floor, which its own case checks.
const requirements = (directory: string, manifest: Manifest) =>
  Arr.getSomes(
    Arr.map(
      Arr.appendAll(
        Record.keys(manifest.dependencies ?? {}),
        Arr.filter(
          Record.keys(manifest.peerDependencies ?? {}),
          (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
        ),
      ),
      (name) => {
        if (name === "effect") return Option.none();
        const required = Str.startsWith("@confect/")(name)
          ? Option.fromUndefinedOr(byName.get(name)?.manifest)
          : Option.some(
              readManifest(
                require.resolve(`${name}/package.json`, {
                  paths: [directory],
                }),
              ),
            );
        return Option.map(
          Option.flatMap(required, effectFloor),
          (requiredFloor) => ({ name, floor: requiredFloor }),
        );
      },
    ),
  );

test.each(Arr.map(published, (entry) => entry.manifest.name))(
  "%s peers Effect at or above every floor its required packages need",
  (name) => {
    const { directory, manifest } = byName.get(name)!;
    const own = effectFloor(manifest);
    for (const requirement of requirements(directory, manifest)) {
      expect(
        Option.match(own, {
          onNone: () => false,
          onSome: (version) => semver(version, requirement.floor) >= 0,
        }),
        `${name} peers effect ${manifest.peerDependencies?.effect}, but ${requirement.name} needs effect ${requirement.floor}`,
      ).toBe(true);
    }
  },
);

test.each(Record.keys(profiles))(
  "the %s baseline consumer installs the Effect floor its packages advertise",
  (profile) => {
    const advertised = Arr.match(
      Arr.getSomes(
        Arr.map(profiles[profile].packages, (directory) =>
          effectFloor(byName.get(`@confect/${directory}`)!.manifest),
        ),
      ),
      { onEmpty: () => undefined, onNonEmpty: Arr.max(semver) },
    );
    expect(consumerDependencies(profile, "baseline").effect).toBe(advertised!);
  },
);
