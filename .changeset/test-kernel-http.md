---
"@confect/test": patch
---

The internal test kernel, and `TestConfect.layer` with `target: "kernel"`, now serve HTTP routes. `fetch(path)` sends the request to the root `http` router, whose own `lookup` picks the route by pathname and method, and runs its handler as an action with the caller's identity, the request's headers and its exact body bytes. A request no route matches gets the binary's 404 `No matching routes found`, a HEAD request gets no body, and a path that does not start with `/` is refused with `InvalidFetchPath`. A mounted component's HTTP module is now built only by its mount, at the mount's site URL, so a module that fails to build fails only that mount's requests.
