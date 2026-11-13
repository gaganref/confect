---
"@confect/cli": patch
---

Codegen writes the same files, manifest and digest whatever order the operating system and Node list a directory in. Node's recursive `readdir` walks in an order that differs between Node versions, so the same project gave a different manifest order, and so a different digest, on Node 24 and Node 26. Discovery of specs, implementations and tables now sorts paths by code unit, and each manifest section lists its functions in path order. The digest of a project that listed its modules out of order changes once.
