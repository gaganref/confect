---
"@confect/core": major
"@confect/cli": major
"@confect/alchemy": major
---

Require the closed format 1 contract when codegen or Alchemy reads a generated manifest.

### Breaking changes

- `Manifest.Manifest` requires `format: 1`, `name`, `env`, `mounts`, `http`, `sections` and `digest`. Unknown fields and slot kinds are refused.
- Extension data lives under `sections`. Route leaves use `endpoint`, and standalone `Convex.Code` accepts `manifestDigest`.
- Every manifest digest changes. It covers emitted fields, source inputs, mounted component digests and the CLI release, with sorted object keys and LF source text.
- Derived deployment variables use acronym-aware names such as `HTTP_SERVER_KEY`. Renaming a mount changes those names.

To migrate, regenerate each component before its host with `confect codegen` on the same release as the reader. Commit the generated files and update the stack's typed mount settings. Health checks fail after 30 seconds if the deployment does not answer its expected manifest digest.
