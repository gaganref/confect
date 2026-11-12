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

Run on Effect 4.1. The fork's packages drop their `<4.1.0` caps: the server and CLI peer `effect` and `@effect/platform-node` at `~4.1.0`, and the CLI no longer asks for `@effect/platform-node-shared`. `@confect/alchemy` targets Alchemy `2.0.0-beta.86`. Run `confect codegen` after upgrading, because generated services now export `DocumentIds`.
