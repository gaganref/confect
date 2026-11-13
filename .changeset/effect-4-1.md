---
"@confect/alchemy": minor
"@confect/cli": minor
"@confect/core": minor
"@confect/foldkit": minor
"@confect/js": minor
"@confect/react": minor
"@confect/server": minor
"@confect/test": minor
---

Run on Effect 4.1. The fork's packages drop their `<4.1.0` caps: the server, CLI and Alchemy packages peer `effect` at `~4.1.4`, the server and CLI peer `@effect/platform-node` at `~4.1.4`, `@confect/test` peers `effect` at `^4.1.4`, and the CLI no longer asks for `@effect/platform-node-shared`. `@confect/alchemy` targets Alchemy `2.0.0-beta.86`. Install Effect 4.1.4 or a later 4.1 patch, because the server's `@effect/ai-*` 4.1.4 dependencies and Alchemy beta.86 need it. Run `confect codegen` after upgrading, because generated services now export `DocumentIds`.
