---
"@confect/alchemy": patch
"@confect/cli": patch
"@confect/core": patch
"@confect/foldkit": patch
"@confect/js": patch
"@confect/react": patch
"@confect/server": patch
"@confect/test": patch
---

Declare Effect 4.0 compatibility across the package set while the CLI and Alchemy still use the Crypto API removed in Effect 4.1. Bound the Node platform companions and declare the matching shared runtime as a CLI peer. An application that installs the CLI lists `@effect/platform-node-shared` directly; with pnpm, leaving it out lets `@effect/platform-node` resolve a 4.1 copy, and the CLI fails at start.
