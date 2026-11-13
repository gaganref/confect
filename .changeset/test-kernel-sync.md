---
"@confect/test": patch
---

The test kernel serves the Convex client sync protocol in process: the unmodified Convex client connects through a socket constructor the kernel provides, and sees query updates, mutation and action responses, identity changes and reconnects as a deployment would send them. A resent mutation is answered from its session's ledger, a presented token is verified as the binary verifies it, and the protocol's records mark every declared secret.
