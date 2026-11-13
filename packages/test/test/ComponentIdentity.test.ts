import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import refs from "../../server/test/local-backend/fixtures/confect/_generated/refs";
import { expected, subject } from "./fixtures/componentIdentityProbe";
import { call, localBackendWorld } from "./fixtures/localBackendWorld";

const probe = refs.public.groups.componentIdentity;

describe("component identity on the kernel", () => {
  it.effect(
    "a component and every mount nested under it read no identity, whether a query, a mutation or an action calls in",
    () =>
      Effect.gen(function* () {
        const t = localBackendWorld().withIdentity({ subject });
        expect({
          query: yield* call(t, "query", probe.fromQuery),
          mutation: yield* call(t, "mutation", probe.fromMutation),
          action: yield* call(t, "action", probe.fromAction),
        }).toEqual(expected);
      }),
  );
});
