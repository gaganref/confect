import * as CustomDomain from "@confect/alchemy/CustomDomain";
import * as Deployment from "@confect/alchemy/Deployment";
import {
  ConvexApiError,
  ConvexConflict,
  ConvexClient,
  layer as clientLayer,
} from "@confect/alchemy/ConvexClient";
import { Providers } from "@confect/alchemy/Providers";
import { expect, it } from "@effect/vitest";
import * as Provider from "alchemy/Provider";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Array from "effect/Array";
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

it.effect.each([403, 409])(
  "keeps the old domain and canonical URL when a rename fails with %s",
  (status) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const next = { ...props, domain: "new.example.com", canonical: true };
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        createCustomDomain: (name, input) =>
          input.domain === next.domain
            ? Effect.fail(
                status === 409
                  ? ConvexConflict.make({
                      operation: "createCustomDomain",
                      status,
                      code: "HttpError",
                    })
                  : ConvexApiError.make({
                      operation: "createCustomDomain",
                      status,
                      code: "HttpError",
                    }),
              )
            : fixture.client.createCustomDomain(name, input),
      });
      const engine = yield* makeEngine(client.pipe(providers));
      yield* engine.run(resource({ ...props, canonical: true }));
      verify(fixture);
      yield* engine.run(resource({ ...props, canonical: true }));
      expect(
        fixture.state.canonicalUrls[props.deployment.url]?.convexCloudUrl,
      ).toBe("https://api.example.com");
      const result = yield* engine.run(resource(next)).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { status } });
      expect(fixture.state.domains).toMatchObject([{ domain: props.domain }]);
      expect(fixture.state.domains).toHaveLength(1);
      expect(
        fixture.state.canonicalUrls[props.deployment.url]?.convexCloudUrl,
      ).toBe("https://api.example.com");
      expect(fixture.client.deleteCustomDomain).not.toHaveBeenCalled();
    }),
);

it.effect(
  "creates a renamed domain before retiring its old canonical owner",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        createCustomDomain: (name, input) =>
          fixture.client
            .createCustomDomain(name, input)
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => verify(fixture, input.domain)),
              ),
            ),
        deleteCustomDomain: (name, input) =>
          Effect.gen(function* () {
            expect(fixture.state.domains).toHaveLength(2);
            expect(fixture.state.domains).toMatchObject([
              { domain: props.domain },
              { domain: "new.example.com" },
            ]);
            yield* fixture.client.deleteCustomDomain(name, input);
          }),
      });
      const engine = yield* makeEngine(client.pipe(providers));
      yield* engine.run(resource({ ...props, canonical: true }));
      const news = { ...props, domain: "new.example.com", canonical: true };
      const output = yield* engine.run(resource(news));
      expect(engine.plans.at(-1)).toEqual([
        { fqn: "Domain", action: "replace", deleteFirst: false },
      ]);
      expect(output).toEqual({
        url: "https://new.example.com",
        canonicalUrl: "https://new.example.com",
        verificationTime: 200,
      });
      expect(fixture.state.domains).toHaveLength(1);
      expect(fixture.state.domains[0]?.domain).toBe(news.domain);
      expect(
        fixture.state.canonicalUrls[props.deployment.url]?.convexCloudUrl,
      ).toBe("https://new.example.com");
      yield* engine.run(resource(news));
      const rows = yield* engine.rows();
      expect(rows).toMatchObject([
        { status: "created", attr: { domain: news.domain } },
      ]);
    }),
);

it.effect.each([
  { requestDestination: "convexSite" as const },
  { deployment: { ...props.deployment, name: "other" } },
  { deployment: { ...props.deployment, url: "https://other.convex.cloud" } },
])(
  "warns during plan about a same-hostname move $requestDestination $deployment",
  (change) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      yield* engine.run(resource());
      yield* engine.run(resource({ ...props, ...change }), { apply: false });
      expect(engine.plans.at(-1)).toEqual([
        { fqn: "Domain", action: "replace", deleteFirst: true },
      ]);
      expect(Array.join(engine.logs, "\n")).toContain(props.domain);
      expect(Array.join(engine.logs, "\n")).toContain("DNS");
      expect(fixture.client.deleteCustomDomain).not.toHaveBeenCalled();
      yield* engine.run(resource({ ...props, ...change }));
      expect(fixture.state.domains).toHaveLength(1);
      expect(fixture.client.deleteCustomDomain).toHaveBeenCalledTimes(1);
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

it.effect(
  "recovers a lost replacement create response with adoption and then removes the old domain",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const news = { ...props, domain: "new.example.com" };
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        createCustomDomain: (name, input) =>
          fixture.client
            .createCustomDomain(name, input)
            .pipe(
              Effect.andThen(
                input.domain === news.domain
                  ? Effect.fail(transportError("createCustomDomain"))
                  : Effect.void,
              ),
            ),
      });
      const engine = yield* makeEngine(client.pipe(providers));
      yield* engine.run(resource());
      const failed = yield* engine.run(resource(news)).pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      expect(fixture.state.domains).toHaveLength(2);
      const refused = yield* engine.run(resource(news)).pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "OwnedBySomeoneElse" },
      });
      yield* engine.run(resource(news), { adopt: true });
      yield* engine.run(resource(news));
      expect(fixture.state.domains).toHaveLength(1);
      expect(fixture.state.domains[0]?.domain).toBe(news.domain);
      expect(fixture.client.createCustomDomain).toHaveBeenCalledTimes(2);
      const rows = yield* engine.rows();
      expect(rows).toMatchObject([
        { status: "created", attr: { domain: news.domain } },
      ]);
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
  "retains attempted canonical ownership after a lost enable response",
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
      const token = "made-up-domain-http-token";
      const authorizations: (string | undefined)[] = [];
      const http = HttpClient.make((request) => {
        authorizations.push(request.headers.authorization);
        const response =
          request.method === "GET"
            ? Response.json({ domains: [] })
            : new Response(token, { status: 403 });
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
