import * as CustomDomain from "@confect/alchemy/CustomDomain";
import * as Deployment from "@confect/alchemy/Deployment";
import {
  ConvexApiError,
  ConvexClient,
  layer as clientLayer,
} from "@confect/alchemy/ConvexClient";
import { Providers } from "@confect/alchemy/Providers";
import { expect, it } from "@effect/vitest";
import * as Provider from "alchemy/Provider";
import { StateStoreError } from "alchemy/State/State";
import * as Output from "alchemy/Output";
import { renamedFrom } from "alchemy/Rename";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Latch from "effect/Latch";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Array from "effect/Array";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { inspect } from "node:util";
import { makeEngine } from "../fixtures/Engine";
import { mockClient } from "../fixtures/ConvexClient";

const props: CustomDomain.CustomDomainProps = {
  deployment: {
    name: "happy-otter-123",
    url: "https://happy-otter-123.convex.cloud",
  },
  domain: "api.example.com",
  requestDestination: "convexCloud",
};
const resource = (news = props) =>
  Effect.gen(function* () {
    const domain = yield* CustomDomain.CustomDomain("Domain", news);
    return {
      url: domain.url,
      canonicalUrl: domain.canonicalUrl,
      verificationTime: domain.verificationTime,
    };
  });
const providers = (client: Layer.Layer<ConvexClient>) =>
  Layer.effect(
    Providers,
    Provider.collection([CustomDomain.CustomDomain]),
  ).pipe(Layer.provide(CustomDomain.layer), Layer.provide(client));
const verify = (
  fixture: ReturnType<typeof mockClient>,
  domain = props.domain,
) => {
  fixture.state.domains = Array.map(fixture.state.domains, (current) =>
    current.domain === domain ? { ...current, verificationTime: 200 } : current,
  );
};
const transportError = (operation: string) =>
  ConvexApiError.make({ operation, code: "TransportError" });

it.effect.each([
  "canonical-before",
  "canonical-response",
  "state-write",
] as const)(
  "resumes a plain create after %s failure without adoption",
  (fault) =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      let injected = false;
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        updateCanonicalUrl: (url, input) =>
          Effect.gen(function* () {
            if (!injected && fault === "canonical-before") {
              injected = true;
              return yield* transportError("updateCanonicalUrl");
            }
            yield* fixture.client.updateCanonicalUrl(url, input);
            if (!injected && fault === "canonical-response") {
              injected = true;
              return yield* transportError("updateCanonicalUrl");
            }
          }),
      });
      const engine = yield* makeEngine(client.pipe(providers), (store) => ({
        ...store,
        set: (request) =>
          Effect.suspend(() => {
            if (
              !injected &&
              fault === "state-write" &&
              request.value.status === "created"
            ) {
              injected = true;
              return Effect.fail(
                new StateStoreError({
                  message: "Injected create state failure",
                }),
              );
            }
            return store.set(request);
          }),
      }));
      const news = { ...props, canonical: true };
      const failed = yield* engine.run(resource(news)).pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      expect(injected).toBe(true);
      expect(fixture.state.domains).toHaveLength(1);
      const output = yield* engine.run(resource(news));
      expect(output).toEqual({
        url: oldUrl,
        canonicalUrl: oldUrl,
        verificationTime: 200,
      });
      expect(fixture.client.createCustomDomain).toHaveBeenCalledTimes(1);
      const rows = yield* engine.rows();
      expect(rows).toMatchObject([
        { attr: { domain: props.domain, canonicalUrl: oldUrl } },
      ]);
    }),
);

const nextDomain = "new.example.com";
const oldUrl = `https://${props.domain}`;
const nextUrl = `https://${nextDomain}`;
const checkedClient = (fixture: ReturnType<typeof mockClient>) => {
  const check = Effect.sync(() => {
    const live =
      fixture.state.canonicalUrls[props.deployment.url]?.convexCloudUrl ??
      props.deployment.url;
    expect(
      live === props.deployment.url ||
        Array.some(
          fixture.state.domains,
          (domain) => `https://${domain.domain}` === live,
        ),
    ).toBe(true);
  });
  return Layer.succeed(ConvexClient, {
    ...fixture.client,
    createCustomDomain: (name, input) =>
      fixture.client
        .createCustomDomain(name, input)
        .pipe(Effect.tap(() => check)),
    deleteCustomDomain: (name, input) =>
      fixture.client
        .deleteCustomDomain(name, input)
        .pipe(Effect.tap(() => check)),
    updateCanonicalUrl: (url, input) =>
      fixture.client
        .updateCanonicalUrl(url, input)
        .pipe(Effect.tap(() => check)),
  });
};
const move = (
  old: boolean | undefined,
  next: boolean | undefined,
  nextFirst = false,
) =>
  Effect.gen(function* () {
    const entries = [
      ...(old === undefined
        ? []
        : [{ id: "Old", domain: props.domain, canonical: old }]),
      ...(next === undefined
        ? []
        : [{ id: "New", domain: nextDomain, canonical: next }]),
    ];
    if (nextFirst) entries.reverse();
    for (const entry of entries)
      yield* CustomDomain.CustomDomain(entry.id, {
        ...props,
        domain: entry.domain,
        canonical: entry.canonical,
      });
    return {};
  });

const snapshot = Effect.fn("Test.domainSnapshot")(function* (
  fixture: ReturnType<typeof mockClient>,
  engine: Effect.Success<ReturnType<typeof makeEngine>>,
  expected?: {
    domains: string[];
    live: string;
    saved: Record<string, string | undefined>;
  },
) {
  const rows = yield* engine.rows();
  const urls = yield* fixture.client.getCanonicalUrls(props.deployment.url);
  const domains = Array.map(
    fixture.state.domains,
    (domain) => domain.domain,
  ).sort();
  expect(
    urls.convexCloudUrl === props.deployment.url ||
      Array.some(
        domains,
        (domain) => `https://${domain}` === urls.convexCloudUrl,
      ),
  ).toBe(true);
  const actual = {
    domains,
    live: urls.convexCloudUrl,
    saved: Record.fromEntries(
      Array.flatMap(rows, (row) =>
        row === undefined || row.kind === "action"
          ? []
          : [[row.fqn, row.attr?.canonicalUrl] as const],
      ),
    ),
  };
  if (expected !== undefined) expect(actual).toEqual(expected);
  return actual;
});

it.effect("moves to a second declaration through three plain lifecycles", () =>
  Effect.gen(function* () {
    const fixture = mockClient();
    const engine = yield* makeEngine(checkedClient(fixture).pipe(providers));
    yield* engine.run(move(true, undefined));
    yield* snapshot(fixture, engine, {
      domains: [props.domain],
      live: props.deployment.url,
      saved: { Old: props.deployment.url },
    });
    verify(fixture);
    yield* engine.run(move(true, undefined));
    yield* snapshot(fixture, engine, {
      domains: [props.domain],
      live: oldUrl,
      saved: { Old: oldUrl },
    });
    for (let apply = 0; apply < 2; apply++) {
      yield* engine.run(move(true, false));
      yield* snapshot(fixture, engine, {
        domains: [props.domain, nextDomain],
        live: oldUrl,
        saved: { Old: oldUrl, New: oldUrl },
      });
    }
    verify(fixture, nextDomain);
    yield* engine.run(move(true, false));
    yield* snapshot(fixture, engine, {
      domains: [props.domain, nextDomain],
      live: oldUrl,
      saved: { Old: oldUrl, New: oldUrl },
    });
    const rows = yield* engine.rows();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fqn: "New",
          attr: expect.objectContaining({ verificationTime: 200 }),
        }),
      ]),
    );
    yield* engine.run(move(false, true));
    yield* snapshot(fixture, engine, {
      domains: [props.domain, nextDomain],
      live: nextUrl,
      saved: { Old: props.deployment.url, New: nextUrl },
    });
    yield* engine.run(move(undefined, true));
    yield* snapshot(fixture, engine, {
      domains: [nextDomain],
      live: nextUrl,
      saved: { New: nextUrl },
    });
  }),
);

it.effect.each([false, true])(
  "combines canonical handover and old removal with new declared first=%s",
  (nextFirst) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(checkedClient(fixture).pipe(providers));
      yield* engine.run(move(true, undefined, nextFirst));
      yield* snapshot(fixture, engine, {
        domains: [props.domain],
        live: props.deployment.url,
        saved: { Old: props.deployment.url },
      });
      verify(fixture);
      yield* engine.run(move(true, undefined));
      yield* snapshot(fixture, engine, {
        domains: [props.domain],
        live: oldUrl,
        saved: { Old: oldUrl },
      });

      for (let apply = 0; apply < 2; apply++) {
        yield* engine.run(move(true, false, nextFirst));
        yield* snapshot(fixture, engine, {
          domains: [props.domain, nextDomain],
          live: oldUrl,
          saved: { Old: oldUrl, New: oldUrl },
        });
      }
      verify(fixture, nextDomain);
      yield* engine.run(move(undefined, true, nextFirst));
      yield* snapshot(fixture, engine, {
        domains: [nextDomain],
        live: nextUrl,
        saved: { New: nextUrl },
      });
    }),
);

it.effect(
  "refuses the new canonical declaration while the old one is canonical",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      const engine = yield* makeEngine(checkedClient(fixture).pipe(providers));
      yield* engine.run(move(true, undefined));
      const before = yield* snapshot(fixture, engine);
      expect(before).toEqual({
        domains: [props.domain],
        live: oldUrl,
        saved: { Old: oldUrl },
      });
      const rows = yield* engine.rows();
      const mutations = [
        fixture.client.createCustomDomain.mock.calls.length,
        fixture.client.deleteCustomDomain.mock.calls.length,
        fixture.client.updateCanonicalUrl.mock.calls.length,
      ];
      const refused = yield* engine.run(move(true, true)).pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConflictingCanonicalDomains" },
      });
      yield* snapshot(fixture, engine, before);
      const savedRows1 = yield* engine.rows();
      expect(savedRows1).toEqual(rows);
      expect([
        fixture.client.createCustomDomain.mock.calls.length,
        fixture.client.deleteCustomDomain.mock.calls.length,
        fixture.client.updateCanonicalUrl.mock.calls.length,
      ]).toEqual(mutations);
    }),
);

it.effect(
  "resets the old canonical URL when the operator removes it before verification",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(checkedClient(fixture).pipe(providers));
      yield* engine.run(move(true, undefined));
      yield* snapshot(fixture, engine, {
        domains: [props.domain],
        live: props.deployment.url,
        saved: { Old: props.deployment.url },
      });
      verify(fixture);
      yield* engine.run(move(true, undefined));
      yield* snapshot(fixture, engine, {
        domains: [props.domain],
        live: oldUrl,
        saved: { Old: oldUrl },
      });

      for (let apply = 0; apply < 2; apply++) {
        yield* engine.run(move(true, false));
        yield* snapshot(fixture, engine, {
          domains: [props.domain, nextDomain],
          live: oldUrl,
          saved: { Old: oldUrl, New: oldUrl },
        });
      }
      yield* engine.run(move(undefined, true));
      yield* snapshot(fixture, engine, {
        domains: [nextDomain],
        live: props.deployment.url,
        saved: { New: oldUrl },
      });
      yield* engine.run(move(undefined, true));
      yield* snapshot(fixture, engine, {
        domains: [nextDomain],
        live: props.deployment.url,
        saved: { New: props.deployment.url },
      });
      verify(fixture, nextDomain);
      yield* engine.run(move(undefined, true));
      yield* snapshot(fixture, engine, {
        domains: [nextDomain],
        live: nextUrl,
        saved: { New: nextUrl },
      });
    }),
);

it.effect(
  "abandons an unverified second declaration without touching the live domain",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(checkedClient(fixture).pipe(providers));
      yield* engine.run(move(true, undefined));
      yield* snapshot(fixture, engine, {
        domains: [props.domain],
        live: props.deployment.url,
        saved: { Old: props.deployment.url },
      });
      verify(fixture);
      yield* engine.run(move(true, undefined));
      const before = yield* snapshot(fixture, engine);
      expect(before).toEqual({
        domains: [props.domain],
        live: oldUrl,
        saved: { Old: oldUrl },
      });
      const originalRows = yield* engine.rows();
      for (let apply = 0; apply < 4; apply++) {
        yield* engine.run(move(true, false));
        yield* snapshot(fixture, engine, {
          domains: [props.domain, nextDomain],
          live: oldUrl,
          saved: { Old: oldUrl, New: oldUrl },
        });
      }
      yield* engine.run(move(true, undefined));
      yield* snapshot(fixture, engine, before);
      const savedRows2 = yield* engine.rows();
      expect(savedRows2).toEqual(originalRows);
      expect(fixture.client.deleteCustomDomain.mock.calls).toEqual([
        [
          props.deployment.name,
          { domain: nextDomain, requestDestination: props.requestDestination },
        ],
      ]);
    }),
);

it.effect(
  "requires a removal deploy after a same-hostname cross-deployment conflict",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      const target = { name: "other", url: "https://other.convex.cloud" };
      const engine = yield* makeEngine(checkedClient(fixture).pipe(providers));
      yield* engine.run(move(true, undefined));
      yield* snapshot(fixture, engine, {
        domains: [props.domain],
        live: oldUrl,
        saved: { Old: oldUrl },
      });
      const moved = Effect.gen(function* () {
        yield* CustomDomain.CustomDomain("New", {
          ...props,
          deployment: target,
          canonical: true,
        });
        return {};
      });
      const first = yield* engine.run(moved).pipe(Effect.result);
      expect(first).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConvexConflict" },
      });
      yield* snapshot(fixture, engine, {
        domains: [props.domain],
        live: oldUrl,
        saved: { Old: oldUrl, New: undefined },
      });
      const repeated = yield* engine.run(moved).pipe(Effect.result);
      expect(repeated).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConvexConflict" },
      });
      yield* snapshot(fixture, engine, {
        domains: [props.domain],
        live: oldUrl,
        saved: { Old: oldUrl, New: undefined },
      });
      expect(fixture.client.deleteCustomDomain).not.toHaveBeenCalled();
      yield* engine.run(Effect.succeed({}));
      yield* snapshot(fixture, engine, {
        domains: [],
        live: props.deployment.url,
        saved: {},
      });
      yield* engine.run(moved);
      yield* snapshot(fixture, engine, {
        domains: [props.domain],
        live: props.deployment.url,
        saved: { New: oldUrl },
      });
      expect(fixture.state.domains).toMatchObject([
        { deploymentName: target.name, domain: props.domain },
      ]);
      expect(fixture.state.domains).toHaveLength(1);
      const urls = yield* fixture.client.getCanonicalUrls(target.url);
      expect(urls.convexCloudUrl).toBe(oldUrl);
      const rows = yield* engine.rows();
      expect(rows).toMatchObject([
        { fqn: "New", attr: { canonicalUrl: oldUrl } },
      ]);
      expect(rows).toHaveLength(1);
    }),
);

it.effect.each([
  { domain: "other.example.com" },
  { requestDestination: "convexSite" as const },
  { deployment: { ...props.deployment, name: "other" } },
])(
  "refuses identity edits at plan time without changing the live resource $domain $requestDestination $deployment",
  (change) =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      yield* engine.run(resource({ ...props, canonical: true }));
      const before = yield* engine.rows();
      fixture.client.listCustomDomains.mockClear();
      fixture.client.getCanonicalUrls.mockClear();
      fixture.client.createCustomDomain.mockClear();
      const refused = yield* engine
        .run(resource({ ...props, canonical: true, ...change }), {
          apply: false,
        })
        .pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CustomDomainIdentityChange" },
      });
      const savedRows3 = yield* engine.rows();
      expect(savedRows3).toEqual(before);
      expect(fixture.state.domains).toHaveLength(1);
      expect(
        fixture.state.canonicalUrls[props.deployment.url]?.convexCloudUrl,
      ).toBe(oldUrl);
      expect(fixture.client.listCustomDomains).not.toHaveBeenCalled();
      expect(fixture.client.getCanonicalUrls).not.toHaveBeenCalled();
      expect(fixture.client.createCustomDomain).not.toHaveBeenCalled();
      expect(fixture.client.deleteCustomDomain).not.toHaveBeenCalled();
    }),
);

it.effect.each(["remove", "opt-out"] as const)(
  "preserves an externally changed canonical URL on %s",
  (operation) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      const news = { ...props, canonical: true };
      yield* engine.run(resource(news));
      verify(fixture);
      yield* engine.run(resource(news));
      yield* fixture.client.updateCanonicalUrl(props.deployment.url, {
        requestDestination: props.requestDestination,
        url: "https://manual.example.com",
      });
      const mutations = fixture.client.updateCanonicalUrl.mock.calls.length;
      yield* engine.run(
        operation === "remove"
          ? Effect.succeed({})
          : resource({ ...props, canonical: false }),
      );
      expect(
        fixture.state.canonicalUrls[props.deployment.url]?.convexCloudUrl,
      ).toBe("https://manual.example.com");
      expect(fixture.client.updateCanonicalUrl).toHaveBeenCalledTimes(
        mutations,
      );
    }),
);

it.effect(
  "retries removal after a lost canonical reset response without resetting twice",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      let resetAttempts = 0;
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        updateCanonicalUrl: (url, input) =>
          fixture.client.updateCanonicalUrl(url, input).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (input.url === undefined && ++resetAttempts === 1)
                  return Effect.fail(transportError("updateCanonicalUrl"));
                return Effect.void;
              }),
            ),
          ),
      });
      const engine = yield* makeEngine(client.pipe(providers));
      const news = { ...props, canonical: true };
      yield* engine.run(resource(news));
      verify(fixture);
      yield* engine.run(resource(news));
      const failed = yield* engine.run(Effect.succeed({})).pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      expect(fixture.state.domains).toHaveLength(1);
      expect(
        fixture.state.canonicalUrls[props.deployment.url]?.convexCloudUrl,
      ).toBe(props.deployment.url);
      yield* engine.run(Effect.succeed({}));
      expect(resetAttempts).toBe(1);
      expect(fixture.state.domains).toEqual([]);
      const rows = yield* engine.rows();
      expect(rows).toEqual([]);
    }),
);

it.effect.each([false, true])(
  "recovers a lost domain create response with adoption=%s",
  (adopt) =>
    Effect.gen(function* () {
      const fixture = mockClient({ deployKey: "made-up-domain-token" });
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        createCustomDomain: (name, input) =>
          fixture.client
            .createCustomDomain(name, input)
            .pipe(
              Effect.andThen(Effect.fail(transportError("createCustomDomain"))),
            ),
      });
      const engine = yield* makeEngine(client.pipe(providers));
      const first = yield* engine.run(resource()).pipe(Effect.result);
      expect(Result.isFailure(first)).toBe(true);
      const retried = yield* engine
        .run(resource(), { adopt })
        .pipe(Effect.result);
      if (adopt) {
        expect(retried).toEqual(
          Result.succeed({
            url: "https://api.example.com",
            canonicalUrl: props.deployment.url,
            verificationTime: null,
          }),
        );
        yield* engine.run(resource());
        const rows = yield* engine.rows();
        expect(rows).toMatchObject([
          { status: "created", attr: { domain: props.domain } },
        ]);
      } else {
        expect(retried).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "OwnedBySomeoneElse",
            message: expect.stringContaining("--adopt"),
          },
        });
      }
      expect(fixture.state.domains).toHaveLength(1);
      expect(fixture.client.createCustomDomain).toHaveBeenCalledTimes(1);
      const rows = yield* engine.rows();
      expect(
        inspect([first, retried, rows, engine.plans, engine.logs]),
      ).not.toContain("made-up-domain-token");
    }),
);

it.effect("refreshes verification time in the plan and saved outputs", () =>
  Effect.gen(function* () {
    const fixture = mockClient();
    const engine = yield* makeEngine(fixture.layer.pipe(providers));
    const first = yield* engine.run(resource());
    expect(first?.verificationTime).toBeNull();
    verify(fixture);
    const second = yield* engine.run(resource());
    expect(engine.plans.at(-1)).toEqual([
      { fqn: "Domain", action: "update", deleteFirst: false },
    ]);
    expect(second?.verificationTime).toBe(200);
    yield* engine.run(resource());
    expect(engine.plans.at(-1)?.[0]?.action).toBe("noop");
  }),
);

it.effect(
  "keeps canonical pending until a later apply observes verification",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      const news = { ...props, canonical: true };
      const first = yield* engine.run(resource(news));
      expect(first).toEqual({
        url: "https://api.example.com",
        canonicalUrl: props.deployment.url,
        verificationTime: null,
      });
      expect(fixture.client.updateCanonicalUrl).not.toHaveBeenCalled();
      expect(Array.join(engine.logs, "\n")).toContain("pending verification");
      yield* engine.run(resource(news));
      expect(fixture.client.updateCanonicalUrl).not.toHaveBeenCalled();
      expect(engine.plans.at(-1)?.[0]?.action).toBe("noop");
      verify(fixture);
      const second = yield* engine.run(resource(news));
      expect(engine.plans.at(-1)?.[0]?.action).toBe("update");
      expect(second).toEqual({
        url: "https://api.example.com",
        canonicalUrl: "https://api.example.com",
        verificationTime: 200,
      });
      expect(fixture.client.updateCanonicalUrl).toHaveBeenCalledTimes(1);
      yield* engine.run(resource(news));
      expect(fixture.client.updateCanonicalUrl).toHaveBeenCalledTimes(1);
    }),
);

it.effect(
  "resets a canonical URL equal to this domain after a lost enable response",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        updateCanonicalUrl: (url, input) =>
          fixture.client
            .updateCanonicalUrl(url, input)
            .pipe(
              Effect.andThen(
                input.url === undefined
                  ? Effect.void
                  : Effect.fail(transportError("updateCanonicalUrl")),
              ),
            ),
      });
      const engine = yield* makeEngine(client.pipe(providers));
      yield* engine.run(resource());
      verify(fixture);
      yield* engine.run(resource());
      const failed = yield* engine
        .run(resource({ ...props, canonical: true }))
        .pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      expect(
        fixture.state.canonicalUrls[props.deployment.url]?.convexCloudUrl,
      ).toBe("https://api.example.com");
      yield* engine.run(Effect.succeed({}));
      expect(
        fixture.state.canonicalUrls[props.deployment.url]?.convexCloudUrl,
      ).toBe(props.deployment.url);
      expect(fixture.state.domains).toEqual([]);
    }),
);

it.effect(
  "refuses two canonical owners for the same destination during plan",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      const declarations = Effect.gen(function* () {
        yield* CustomDomain.CustomDomain("One", { ...props, canonical: true });
        yield* CustomDomain.CustomDomain("Two", {
          ...props,
          domain: "other.example.com",
          canonical: true,
        });
        return {};
      });
      const result = yield* engine
        .run(declarations, { apply: false })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConflictingCanonicalDomains" },
      });
      expect(fixture.client.createCustomDomain).not.toHaveBeenCalled();
      expect(fixture.client.updateCanonicalUrl).not.toHaveBeenCalled();
    }),
);

it.effect(
  "refuses canonical owners of the same deployment through different URLs",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      const declarations = Effect.gen(function* () {
        yield* CustomDomain.CustomDomain("One", { ...props, canonical: true });
        yield* CustomDomain.CustomDomain("Two", {
          ...props,
          deployment: {
            ...props.deployment,
            url: "https://happy-otter-123.eu-west-1.convex.cloud",
          },
          domain: nextDomain,
          canonical: true,
        });
        return {};
      });
      const refused = yield* engine
        .run(declarations, { apply: false })
        .pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConflictingCanonicalDomains" },
      });
      expect(fixture.client.createCustomDomain).not.toHaveBeenCalled();
      expect(fixture.client.updateCanonicalUrl).not.toHaveBeenCalled();
    }),
);

it.effect("allows canonical owners for different destinations", () =>
  Effect.gen(function* () {
    const fixture = mockClient();
    const engine = yield* makeEngine(fixture.layer.pipe(providers));
    yield* engine.run(
      Effect.gen(function* () {
        yield* CustomDomain.CustomDomain("One", { ...props, canonical: true });
        yield* CustomDomain.CustomDomain("Two", {
          ...props,
          domain: "site.example.com",
          requestDestination: "convexSite",
          canonical: true,
        });
        return {};
      }),
    );
    expect(fixture.state.domains).toHaveLength(2);
  }),
);

it.effect(
  "refuses canonical owners whose props resolve from Alchemy outputs",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      const declarations = Effect.gen(function* () {
        yield* CustomDomain.CustomDomain("One", {
          ...props,
          canonical: Output.literal(true),
        });
        yield* CustomDomain.CustomDomain("Two", {
          ...props,
          domain: "other.example.com",
          canonical: Output.literal(true),
        });
        return {};
      });
      const result = yield* engine
        .run(declarations, { apply: false })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConflictingCanonicalDomains" },
      });
      expect(fixture.client.createCustomDomain).not.toHaveBeenCalled();
    }),
);

it.effect.each([false, true])(
  "checks canonical owners that share a deployment output with existing=%s",
  (existing) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const collection = Layer.effect(
        Providers,
        Provider.collection([CustomDomain.CustomDomain, Deployment.Deployment]),
      ).pipe(
        Layer.provide(Layer.mergeAll(CustomDomain.layer, Deployment.layer)),
        Layer.provide(fixture.layer),
      );
      const engine = yield* makeEngine(collection);
      const deployment = Deployment.Deployment("Deployment", {
        projectId: 1,
        type: "prod",
        reference: "example",
      });
      if (existing) yield* engine.run(deployment.pipe(Effect.as({})));
      const declarations = Effect.gen(function* () {
        const target = yield* deployment;
        yield* CustomDomain.CustomDomain("One", {
          ...props,
          deployment: target,
          canonical: true,
        });
        yield* CustomDomain.CustomDomain("Two", {
          ...props,
          deployment: target,
          domain: "other.example.com",
          canonical: true,
        });
        return {};
      });
      const result = yield* engine
        .run(declarations, { apply: !existing })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConflictingCanonicalDomains" },
      });
      expect(fixture.client.createCustomDomain).not.toHaveBeenCalled();
      expect(fixture.client.updateCanonicalUrl).not.toHaveBeenCalled();
    }),
);

it.effect(
  "keeps the authenticated HTTP token out of errors, logs, plans and state",
  () =>
    Effect.gen(function* () {
      const token = "MadeUpDomainHttpToken";
      const authorizations: (string | undefined)[] = [];
      const http = HttpClient.make((request) => {
        authorizations.push(request.headers.authorization);
        const response =
          request.method === "GET"
            ? Response.json({ domains: [] })
            : Response.json({ code: token }, { status: 403 });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const client = clientLayer({ token: Redacted.make(token) }).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      );
      const engine = yield* makeEngine(client.pipe(providers));
      const result = yield* engine.run(resource()).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConvexApiError", status: 403 },
      });
      expect(
        Array.some(authorizations, (value) => value === `Bearer ${token}`),
      ).toBe(true);
      const rows = yield* engine.rows();
      expect(
        inspect([result, engine.logs, engine.planOutputs, rows], {
          depth: null,
        }),
      ).not.toContain(token);
    }),
);

it.effect("refreshes a changed live canonical URL in saved outputs", () =>
  Effect.gen(function* () {
    const fixture = mockClient();
    const engine = yield* makeEngine(fixture.layer.pipe(providers));
    yield* engine.run(resource());
    yield* fixture.client.updateCanonicalUrl(props.deployment.url, {
      requestDestination: props.requestDestination,
      url: "https://manual.example.com",
    });
    const output = yield* engine.run(resource());
    expect(engine.plans.at(-1)?.[0]?.action).toBe("update");
    expect(output?.canonicalUrl).toBe("https://manual.example.com");
    const rows = yield* engine.rows();
    expect(rows).toMatchObject([
      { attr: { canonicalUrl: "https://manual.example.com" } },
    ]);
    const again = yield* engine.run(resource());
    expect(again).toEqual(output);
    expect(engine.plans.at(-1)?.[0]?.action).toBe("noop");
  }),
);

it.effect.each([true, false])(
  "removes an adopted noncanonical domain with an external canonical match=%s",
  (matches) =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      yield* fixture.client.createCustomDomain(props.deployment.name, props);
      const url = matches
        ? `https://${props.domain}`
        : "https://manual.example.com";
      yield* fixture.client.updateCanonicalUrl(props.deployment.url, {
        requestDestination: props.requestDestination,
        url,
      });
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      yield* engine.run(resource(), { adopt: true });
      const rows = yield* engine.rows();
      expect(rows).toMatchObject([
        { attr: { canonical: false, canonicalUrl: url } },
      ]);
      yield* engine.run(Effect.succeed({}));
      expect(fixture.state.domains).toEqual([]);
      const live = yield* fixture.client.getCanonicalUrls(props.deployment.url);
      expect(live.convexCloudUrl).toBe(matches ? props.deployment.url : url);
    }),
);

it.effect.each([false, true])(
  "hands canonical from A to B with B declared first=%s",
  (bFirst) =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      let handover = false;
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        getCanonicalUrls: (url) =>
          Effect.gen(function* () {
            const observed = yield* fixture.client.getCanonicalUrls(url);
            if (handover) yield* Effect.yieldNow;
            return observed;
          }),
        updateCanonicalUrl: (url, input) =>
          Effect.gen(function* () {
            if (handover && input.url === undefined) {
              for (let index = 0; index < 5; index++) yield* Effect.yieldNow;
            }
            yield* fixture.client.updateCanonicalUrl(url, input);
          }),
      });
      const engine = yield* makeEngine(client.pipe(providers));
      const declarations = (bCanonical: boolean) =>
        Effect.gen(function* () {
          const entries = [
            { id: "A", domain: props.domain, canonical: !bCanonical },
            { id: "B", domain: "b.example.com", canonical: bCanonical },
          ];
          if (bFirst) entries.reverse();
          for (const entry of entries)
            yield* CustomDomain.CustomDomain(entry.id, {
              ...props,
              domain: entry.domain,
              canonical: entry.canonical,
            });
          return {};
        });
      yield* engine.run(declarations(false));
      handover = true;
      yield* engine.run(declarations(true));
      const urls = yield* fixture.client.getCanonicalUrls(props.deployment.url);
      expect(urls.convexCloudUrl).toBe("https://b.example.com");
      expect(fixture.state.domains).toHaveLength(2);
      yield* engine.run(declarations(true));
      const rows = yield* engine.rows();
      expect(rows).toMatchObject([
        { attr: { canonicalUrl: "https://b.example.com" } },
        { attr: { canonicalUrl: "https://b.example.com" } },
      ]);
    }),
);

it.effect(
  "refuses competing canonical updates after a new deployment output resolves",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      const collection = Layer.effect(
        Providers,
        Provider.collection([CustomDomain.CustomDomain, Deployment.Deployment]),
      ).pipe(
        Layer.provide(Layer.mergeAll(CustomDomain.layer, Deployment.layer)),
        Layer.provide(fixture.layer),
      );
      const engine = yield* makeEngine(collection);
      yield* engine.run(
        Effect.gen(function* () {
          yield* CustomDomain.CustomDomain("One", props);
          yield* CustomDomain.CustomDomain("Two", {
            ...props,
            domain: "other.example.com",
          });
          return {};
        }),
      );
      const updates = Effect.gen(function* () {
        const target = yield* Deployment.Deployment("Deployment", {
          projectId: 1,
          type: "prod",
          reference: "example",
        });
        yield* CustomDomain.CustomDomain("One", {
          ...props,
          deployment: target,
          canonical: true,
        });
        yield* CustomDomain.CustomDomain("Two", {
          ...props,
          deployment: target,
          domain: "other.example.com",
          canonical: true,
        });
        return {};
      });
      const refused = yield* engine.run(updates).pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ConflictingCanonicalDomains",
          deploymentName: props.deployment.name,
          requestDestination: "convexCloud",
          domains: expect.arrayContaining([props.domain, "other.example.com"]),
        },
      });
      expect(fixture.state.domains).toHaveLength(2);
      const urls = yield* fixture.client.getCanonicalUrls(props.deployment.url);
      expect(urls.convexCloudUrl).toBe(props.deployment.url);
    }),
);

it.effect.each([
  { canonical: false, unresolved: false },
  { canonical: true, unresolved: false },
  { canonical: false, unresolved: true },
  { canonical: true, unresolved: true },
])(
  "keeps a renamed domain through adoption with canonical=$canonical unresolved=$unresolved",
  ({ canonical, unresolved }) =>
    Effect.gen(function* () {
      const token = "MadeUpRenameDomainToken";
      const fixture = mockClient({ verificationTime: 200, deployKey: token });
      const collection = Layer.effect(
        Providers,
        Provider.collection([CustomDomain.CustomDomain, Deployment.Deployment]),
      ).pipe(
        Layer.provide(Layer.mergeAll(CustomDomain.layer, Deployment.layer)),
        Layer.provide(checkedClient(fixture)),
      );
      const engine = yield* makeEngine(collection);
      const declarations = (id: string) =>
        Effect.gen(function* () {
          const deployment = unresolved
            ? yield* Deployment.Deployment("Deployment", {
                projectId: 1,
                type: "prod",
                reference: "example",
              })
            : props.deployment;
          yield* CustomDomain.CustomDomain(id, {
            ...props,
            deployment,
            canonical,
          });
          return {};
        });
      yield* engine.run(declarations("Old"));
      const expectedUrl = canonical ? oldUrl : props.deployment.url;
      const refused = yield* engine
        .run(declarations("New"))
        .pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "OwnedBySomeoneElse",
          message: expect.stringContaining("--adopt"),
        },
      });
      expect(fixture.state.domains).toHaveLength(1);
      yield* engine.run(declarations("New"), { adopt: true });
      expect(fixture.state.domains).toMatchObject([
        { domain: props.domain, verificationTime: 200 },
      ]);
      expect(fixture.state.domains).toHaveLength(1);
      expect(fixture.client.deleteCustomDomain).not.toHaveBeenCalled();
      expect(
        (yield* fixture.client.getCanonicalUrls(props.deployment.url))
          .convexCloudUrl,
      ).toBe(expectedUrl);
      expect(Array.join(engine.logs, "\n")).toContain(
        `Skipping delete of ${props.domain}; New keeps it.`,
      );
      yield* engine.run(declarations("New"));
      expect(
        Array.every(
          engine.plans.at(-1) ?? [],
          (node) => node.action === "noop",
        ),
      ).toBe(true);
      const rows = yield* engine.rows();
      expect(
        inspect([rows, engine.logs, engine.planOutputs], { depth: null }),
      ).not.toContain(token);
      yield* engine.run(Effect.succeed({}));
      expect(fixture.state.domains).toEqual([]);
      expect(
        (yield* fixture.client.getCanonicalUrls(props.deployment.url))
          .convexCloudUrl,
      ).toBe(props.deployment.url);
    }),
);

it.effect(
  "keeps a domain adopted by a second declaration until both are removed",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      const engine = yield* makeEngine(checkedClient(fixture).pipe(providers));
      const declarations = (old: boolean) =>
        Effect.gen(function* () {
          if (old) yield* CustomDomain.CustomDomain("Old", props);
          yield* CustomDomain.CustomDomain("New", props);
          return {};
        });
      yield* engine.run(
        CustomDomain.CustomDomain("Old", props).pipe(Effect.as({})),
      );
      yield* fixture.client.updateCanonicalUrl(props.deployment.url, {
        requestDestination: props.requestDestination,
        url: oldUrl,
      });
      yield* engine.run(declarations(true), { adopt: true });
      yield* engine.run(declarations(false));
      expect(fixture.state.domains).toHaveLength(1);
      expect(fixture.client.deleteCustomDomain).not.toHaveBeenCalled();
      expect(
        (yield* fixture.client.getCanonicalUrls(props.deployment.url))
          .convexCloudUrl,
      ).toBe(oldUrl);
      yield* engine.run(declarations(false));
      expect(engine.plans.at(-1)).toEqual([
        { fqn: "New", action: "noop", deleteFirst: false },
      ]);
      yield* engine.run(Effect.succeed({}));
      expect(fixture.state.domains).toEqual([]);
      expect(
        (yield* fixture.client.getCanonicalUrls(props.deployment.url))
          .convexCloudUrl,
      ).toBe(props.deployment.url);
    }),
);

it.effect(
  "deletes a shared domain when all its declarations are removed together",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      const engine = yield* makeEngine(checkedClient(fixture).pipe(providers));
      yield* engine.run(
        CustomDomain.CustomDomain("Old", props).pipe(Effect.as({})),
      );
      yield* engine.run(
        Effect.gen(function* () {
          yield* CustomDomain.CustomDomain("Old", props);
          yield* CustomDomain.CustomDomain("New", props);
          return {};
        }),
        { adopt: true },
      );
      yield* fixture.client.updateCanonicalUrl(props.deployment.url, {
        requestDestination: props.requestDestination,
        url: oldUrl,
      });
      yield* engine.run(Effect.succeed({}));
      expect(fixture.state.domains).toEqual([]);
      expect(
        (yield* fixture.client.getCanonicalUrls(props.deployment.url))
          .convexCloudUrl,
      ).toBe(props.deployment.url);
      const removedRows = yield* engine.rows();
      expect(removedRows).toEqual([]);
    }),
);

it.effect.each(["deployment", "destination"] as const)(
  "deletes a domain when the surviving hostname belongs to another %s",
  (difference) =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      const other =
        difference === "deployment"
          ? {
              ...props,
              deployment: { name: "other", url: "https://other.convex.cloud" },
            }
          : { ...props, requestDestination: "convexSite" as const };
      const declarations = (old: boolean) =>
        Effect.gen(function* () {
          if (old) yield* CustomDomain.CustomDomain("Old", props);
          yield* CustomDomain.CustomDomain("Other", other);
          return {};
        });
      // Model two existing attachments so deletion matching is independent of create conflicts.
      fixture.state.domains = Array.map([props, other], (entry) => ({
        deploymentName: entry.deployment.name,
        domain: entry.domain,
        requestDestination: entry.requestDestination,
        creationTime: 100,
        verificationTime: 200,
      }));
      yield* engine.run(declarations(true), { adopt: true });
      yield* fixture.client.updateCanonicalUrl(props.deployment.url, {
        requestDestination: props.requestDestination,
        url: oldUrl,
      });
      yield* engine.run(declarations(false));
      expect(fixture.state.domains).toEqual([
        {
          deploymentName: other.deployment.name,
          domain: other.domain,
          requestDestination: other.requestDestination,
          creationTime: 100,
          verificationTime: 200,
        },
      ]);
      expect(fixture.client.deleteCustomDomain.mock.calls).toEqual([
        [
          props.deployment.name,
          {
            domain: props.domain,
            requestDestination: props.requestDestination,
          },
        ],
      ]);
      expect(
        (yield* fixture.client.getCanonicalUrls(props.deployment.url))
          .convexCloudUrl,
      ).toBe(props.deployment.url);
    }),
);

it.effect(
  "renames a logical id with renamedFrom without domain mutations",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      const news = { ...props, canonical: true };
      yield* engine.run(
        CustomDomain.CustomDomain("ApiDomain", news).pipe(Effect.as({})),
      );
      fixture.client.createCustomDomain.mockClear();
      fixture.client.deleteCustomDomain.mockClear();
      fixture.client.updateCanonicalUrl.mockClear();
      const declarations = CustomDomain.CustomDomain(
        "PublicApiDomain",
        news,
      ).pipe(renamedFrom("ApiDomain"), Effect.as({}));
      yield* engine.run(declarations);
      expect(engine.plans.at(-1)).toEqual([
        { fqn: "PublicApiDomain", action: "update", deleteFirst: false },
      ]);
      expect(fixture.client.createCustomDomain).not.toHaveBeenCalled();
      expect(fixture.client.deleteCustomDomain).not.toHaveBeenCalled();
      expect(fixture.client.updateCanonicalUrl).not.toHaveBeenCalled();
      expect(fixture.state.domains).toHaveLength(1);
      expect(
        (yield* fixture.client.getCanonicalUrls(props.deployment.url))
          .convexCloudUrl,
      ).toBe(oldUrl);
      const renamedRows = yield* engine.rows();
      expect(renamedRows).toMatchObject([
        { fqn: "PublicApiDomain", attr: { verificationTime: 200 } },
      ]);
      yield* engine.run(declarations);
      expect(engine.plans.at(-1)?.[0]?.action).toBe("noop");
    }),
);

it.effect.each([
  { recovery: "opt-out", adopt: false },
  { recovery: "opt-out", adopt: true },
  { recovery: "remove", adopt: false },
  { recovery: "remove", adopt: true },
])(
  "recovers an apply-time canonical conflict by $recovery with adoption=$adopt",
  ({ recovery, adopt }) =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      const collection = Layer.effect(
        Providers,
        Provider.collection([CustomDomain.CustomDomain, Deployment.Deployment]),
      ).pipe(
        Layer.provide(Layer.mergeAll(CustomDomain.layer, Deployment.layer)),
        Layer.provide(checkedClient(fixture)),
      );
      const engine = yield* makeEngine(collection);
      const declarations = (canonical: boolean | undefined) =>
        Effect.gen(function* () {
          yield* CustomDomain.CustomDomain("Old", {
            ...props,
            canonical: true,
          });
          const deployment = yield* Deployment.Deployment("Deployment", {
            projectId: 1,
            type: "prod",
            reference: "example",
          });
          if (canonical !== undefined)
            yield* CustomDomain.CustomDomain("New", {
              ...props,
              deployment,
              domain: nextDomain,
              canonical,
            });
          return {};
        });
      yield* engine.run(
        CustomDomain.CustomDomain("Old", { ...props, canonical: true }).pipe(
          Effect.as({}),
        ),
      );
      const refused = yield* engine.run(declarations(true)).pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConflictingCanonicalDomains" },
      });
      const failedRows = yield* engine.rows();
      expect(failedRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fqn: "New",
            status: "creating",
            props: expect.objectContaining({ canonical: true }),
          }),
        ]),
      );
      expect(fixture.client.createCustomDomain).toHaveBeenCalledTimes(1);
      const corrected = declarations(
        recovery === "opt-out" ? false : undefined,
      );
      yield* engine.run(corrected, { adopt });
      expect(
        (yield* fixture.client.getCanonicalUrls(props.deployment.url))
          .convexCloudUrl,
      ).toBe(oldUrl);
      expect(fixture.client.updateCanonicalUrl).toHaveBeenCalledTimes(1);
      expect(fixture.state.domains).toHaveLength(
        recovery === "opt-out" ? 2 : 1,
      );
      yield* engine.run(corrected);
      expect(
        Array.every(
          engine.plans.at(-1) ?? [],
          (node) => node.action === "noop",
        ),
      ).toBe(true);
    }),
);

it.effect.each([false, true])(
  "reverts a failed logical rename in one apply with adoption=%s",
  (adopt) =>
    Effect.gen(function* () {
      const token = "MadeUpFailedRenameToken";
      const fixture = mockClient({ verificationTime: 200, deployKey: token });
      const collection = Layer.effect(
        Providers,
        Provider.collection([CustomDomain.CustomDomain, Deployment.Deployment]),
      ).pipe(
        Layer.provide(Layer.mergeAll(CustomDomain.layer, Deployment.layer)),
        Layer.provide(checkedClient(fixture)),
      );
      const engine = yield* makeEngine(collection);
      const declarations = (id: string, fromOutput = false) =>
        Effect.gen(function* () {
          const deployment = fromOutput
            ? yield* Deployment.Deployment("Deployment", {
                projectId: 1,
                type: "prod",
                reference: "example",
              })
            : props.deployment;
          yield* CustomDomain.CustomDomain(id, {
            ...props,
            deployment,
            canonical: true,
          });
          return {};
        });
      yield* engine.run(declarations("Old"));
      const refused = yield* engine
        .run(declarations("New", true))
        .pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "OwnedBySomeoneElse" },
      });
      const failedRows = yield* engine.rows();
      expect(failedRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fqn: "New",
            status: "creating",
            props: expect.objectContaining({ canonical: true }),
          }),
        ]),
      );
      yield* engine.run(declarations("Old", true), { adopt });
      expect(fixture.state.domains).toHaveLength(1);
      expect(fixture.client.deleteCustomDomain).not.toHaveBeenCalled();
      expect(fixture.client.updateCanonicalUrl).toHaveBeenCalledTimes(1);
      expect(
        (yield* fixture.client.getCanonicalUrls(props.deployment.url))
          .convexCloudUrl,
      ).toBe(oldUrl);
      const recoveredRows = yield* engine.rows();
      expect(recoveredRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fqn: "Old",
            status: "updated",
            attr: expect.objectContaining({ canonicalUrl: oldUrl }),
          }),
          expect.objectContaining({ fqn: "Deployment", status: "created" }),
        ]),
      );
      expect(recoveredRows).toHaveLength(2);
      expect(
        inspect(
          [refused, failedRows, recoveredRows, engine.logs, engine.planOutputs],
          { depth: null },
        ),
      ).not.toContain(token);
      yield* engine.run(declarations("Old", true));
      expect(
        Array.every(
          engine.plans.at(-1) ?? [],
          (node) => node.action === "noop",
        ),
      ).toBe(true);
    }),
);

it.effect(
  "does not block another destination while a canonical write is held",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      const cloudEntered = yield* Latch.make();
      const siteEntered = yield* Latch.make();
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        createCustomDomain: (name, input) =>
          fixture.client
            .createCustomDomain(name, input)
            .pipe(
              Effect.andThen(
                input.requestDestination === "convexSite"
                  ? cloudEntered.await
                  : Effect.void,
              ),
            ),
        updateCanonicalUrl: (url, input) =>
          Effect.gen(function* () {
            if (input.requestDestination === "convexCloud") {
              yield* cloudEntered.open;
              yield* siteEntered.await;
            } else {
              yield* siteEntered.open;
            }
            yield* fixture.client.updateCanonicalUrl(url, input);
          }),
      });
      const engine = yield* makeEngine(client.pipe(providers));
      const applying = yield* engine
        .run(
          Effect.gen(function* () {
            yield* CustomDomain.CustomDomain("Cloud", {
              ...props,
              canonical: true,
            });
            yield* CustomDomain.CustomDomain("Site", {
              ...props,
              domain: "site.example.com",
              requestDestination: "convexSite",
              canonical: true,
            });
            return {};
          }),
        )
        .pipe(Effect.timeout("1 second"), Effect.result, Effect.forkScoped);
      yield* cloudEntered.await;
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(applying);
      expect(result).toEqual(Result.succeed({}));
      const urls = yield* fixture.client.getCanonicalUrls(props.deployment.url);
      expect(urls).toEqual({
        convexCloudUrl: oldUrl,
        convexSiteUrl: "https://site.example.com",
      });
    }),
);

it.effect.each([false, true])(
  "retries a creating row with saved attributes and domain missing=%s",
  (missing) =>
    Effect.gen(function* () {
      const fixture = mockClient({ verificationTime: 200 });
      let fail = true;
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        updateCanonicalUrl: (url, input) =>
          Effect.suspend(() => {
            if (fail) {
              fail = false;
              return Effect.fail(transportError("updateCanonicalUrl"));
            }
            return fixture.client.updateCanonicalUrl(url, input);
          }),
      });
      const engine = yield* makeEngine(client.pipe(providers));
      const declarations = resource({ ...props, canonical: true });
      const failed = yield* engine.run(declarations).pipe(Effect.result);
      expect(failed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConvexApiError" },
      });
      const interruptedRows = yield* engine.rows();
      expect(interruptedRows).toMatchObject([
        {
          status: "creating",
          attr: {
            domain: props.domain,
            canonical: true,
            verificationTime: null,
          },
        },
      ]);
      if (missing)
        yield* fixture.client.deleteCustomDomain(props.deployment.name, props);
      const recovered = yield* engine.run(declarations);
      expect(recovered).toEqual({
        url: oldUrl,
        canonicalUrl: oldUrl,
        verificationTime: 200,
      });
      expect(fixture.client.createCustomDomain).toHaveBeenCalledTimes(
        missing ? 2 : 1,
      );
      const rows = yield* engine.rows();
      expect(rows).toMatchObject([
        { status: "created", attr: { canonicalUrl: oldUrl } },
      ]);
      yield* engine.run(declarations);
      expect(engine.plans.at(-1)?.[0]?.action).toBe("noop");
    }),
);

it.effect("deletes a shared domain despite a failed deletion state write", () =>
  Effect.gen(function* () {
    const fixture = mockClient({ verificationTime: 200 });
    let injected = false;
    const engine = yield* makeEngine(
      checkedClient(fixture).pipe(providers),
      (store) => ({
        ...store,
        delete: (request) =>
          Effect.suspend(() => {
            if (request.fqn === "Old" && !injected) {
              injected = true;
              return Effect.fail(
                new StateStoreError({
                  message: "Injected deletion state failure",
                }),
              );
            }
            return store.delete(request);
          }),
      }),
    );
    yield* engine.run(
      CustomDomain.CustomDomain("Old", props).pipe(Effect.as({})),
    );
    yield* engine.run(
      Effect.gen(function* () {
        yield* CustomDomain.CustomDomain("Old", props);
        yield* CustomDomain.CustomDomain("New", props);
        return {};
      }),
      { adopt: true },
    );
    yield* fixture.client.updateCanonicalUrl(props.deployment.url, {
      requestDestination: props.requestDestination,
      url: oldUrl,
    });
    const failed = yield* engine.run(Effect.succeed({})).pipe(Effect.result);
    expect(failed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DestroyError" },
    });
    expect(injected).toBe(true);
    expect(fixture.state.domains).toEqual([]);
    expect(
      (yield* fixture.client.getCanonicalUrls(props.deployment.url))
        .convexCloudUrl,
    ).toBe(props.deployment.url);
    const interruptedRows = yield* engine.rows();
    expect(interruptedRows).toMatchObject([{ fqn: "Old", status: "deleting" }]);
    yield* engine.run(Effect.succeed({}));
    const rows = yield* engine.rows();
    expect(rows).toEqual([]);
    expect(fixture.state.domains).toEqual([]);
  }),
);
