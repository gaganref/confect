# Fork guide

This fork of [Confect](https://github.com/rjdellecese/confect) adds Convex component authoring, typed callbacks, declarative backend configuration, HTTP route labels, Alchemy cloud and local providers, component testing support, and CLI fixes. [CHANGES.md](CHANGES.md) records the patches and their upstream status. The additions are documented in [apps/docs](apps/docs).

This fork takes no issues and no pull requests. Send changes to upstream Confect. Upstream submissions of the patches carried here go through the maintainer.

## Upstream releases

`main` tracks stable upstream releases and is based on upstream 10.3.1. Each release is taken by merge. A scheduled check dry-runs a merge of the newest stable release and lists conflicting files. A maintainer lands the merge through a pull request.

The two remotes are `origin` = <https://github.com/gaganref/confect> and `upstream` = <https://github.com/rjdellecese/confect>. Fork work and pull requests go to `origin`.

## Builds and installation

Every merge to `main` automatically publishes a build to public npm after the same commit's Packages checks pass. Builds use `<upstream>-fork.N`, such as `10.3.1-fork.1`. Source packages retain their `@confect/*` names. `scripts/stageForkPackages.ts` stages eight `@gaganref/confect-*` packages, rewrites internal dependencies as exact aliases, and selects an unused build number across the package set. The `stage` job installs, builds, tests, and packs without publishing identity. The `publish` job downloads the staged artifact and publishes with npm trusted publishing and provenance, without a stored publish token. The `latest` dist-tag follows the newest build. The consumer check waits for the registry to serve the new build before installing, because the public registry lags a publish by a few minutes.

Choose a green [Packages run](https://github.com/gaganref/confect/actions/workflows/packages.yml) that published a build. Replace `<version>` below with that exact version. Pin every alias to the same build. Aliases preserve `@confect/*` imports. Installation needs no registry authentication.

```sh
pnpm add --strict-peer-dependencies '@confect/core@npm:@gaganref/confect-core@<version>' '@confect/server@npm:@gaganref/confect-server@<version>' '@confect/test@npm:@gaganref/confect-test@<version>' '@confect/cli@npm:@gaganref/confect-cli@<version>'
```

PRs exercise the staged tarballs in a fresh strict-peer consumer before publication. The check generates a declared backend and a component mounted at `/counter`, calls the component through the host, checks callback arguments and results, and fetches the declared HTTP routes. Each successful install check uploads its pinned manifest, lockfile, and install command. `bun scripts/forkConsumer.ts <dir> <version>` regenerates the consumer. Dispatch "Packages" on `main` with a higher unused `n` to recover from a build number collision after all checks pass. Dispatch "Publish fork builds" with an existing version to check an installed build without publishing again.

## Initial publication

The automatic publisher prints "bootstrap first: no @gaganref/confect-core on npm yet, nothing published" and succeeds without publishing until the core package exists.

The maintainer publishes build 1 from a terminal under an npm login session with a two-factor prompt. Install dependencies and build the packages first, then stage into a new directory and publish each of the eight tarballs:

```sh
pnpm install --frozen-lockfile
pnpm build
npm login
bun scripts/stageForkPackages.ts <dir> 1
npm publish <tarball> --access public --tag latest
```

Repeat the last command for each tarball in `<dir>/tarballs`. Use the interactive login and two-factor prompt, never a token. The bootstrap publish from a terminal carries no provenance attestation; every build from build 2 onward is published by the workflow with `--provenance` and trusted publishing.

Then add a trusted publisher to each of the eight packages with these settings:

- Organization or user `gaganref`.
- Repository `confect`.
- Workflow filename `packages.yml`.
- Environment name `npm`.
- Allowed actions `npm publish` only.

The caller retains all check gates and invokes `publish.yml` to publish. After the first automatic release, set each package's Publishing access to "Require two-factor authentication and disallow tokens".

## Maintenance

Update the hand-maintained `CHANGES.md` in every fork PR with what changed, why, changeset coverage, and upstream intent or proposal. Keep its topic sections and upstream status current.

The workspace delays new dependency resolution by seven days. Exact-version exceptions retain the fork's already pinned toolchain and dependencies. pnpm also checks lockfile entries against this policy during frozen installs.
