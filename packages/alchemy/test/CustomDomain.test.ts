import { Unowned } from "alchemy/AdoptPolicy";
import { expect, it } from "@effect/vitest";
import * as CustomDomain from "@confect/alchemy/CustomDomain";
import { ConvexApiError, ConvexClient } from "@confect/alchemy/ConvexClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { lifecycle, mockClient } from "./fixtures/ConvexClient";

const props: CustomDomain.CustomDomainProps = {
  deployment: {
    name: "happy-otter-123",
    url: "https://happy-otter-123.convex.cloud",
  },
  domain: "api.example.com",
  requestDestination: "convexCloud",
};

it.effect(
  "creates an unverified domain without changing canonical URLs",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* CustomDomain.provider.pipe(
        Effect.provideContext(services),
      );
      const output = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      const domains = yield* mock.client.listCustomDomains(
        props.deployment.name,
      );
      const urls = yield* mock.client.getCanonicalUrls(props.deployment.url);
      expect({ output, domains, urls }).toEqual({
        output: {
          ...props,
          canonical: false,
          verificationTime: null,
          url: "https://api.example.com",
          canonicalUrl: props.deployment.url,
        },
        domains: [
          {
            deploymentName: props.deployment.name,
            domain: "api.example.com",
            requestDestination: "convexCloud",
            creationTime: 100,
            verificationTime: null,
          },
        ],
        urls: {
          convexCloudUrl: props.deployment.url,
          convexSiteUrl: "https://happy-otter-123.convex.site",
        },
      });
    });
  },
);

it.effect(
  "reconciles a saved domain twice and refuses a domain outside its state",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* CustomDomain.provider.pipe(
        Effect.provideContext(services),
      );
      const first = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      const second = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: props,
        output: first,
      });
      const error = yield* provider
        .reconcile({
          ...lifecycle,
          news: props,
          olds: undefined,
          output: undefined,
        })
        .pipe(Effect.flip);
      const domains = yield* mock.client.listCustomDomains(
        props.deployment.name,
      );
      expect({ second, error: error._tag, domains }).toEqual({
        second: first,
        error: "OwnedBySomeoneElse",
        domains: [
          {
            deploymentName: props.deployment.name,
            domain: props.domain,
            requestDestination: props.requestDestination,
            creationTime: 100,
            verificationTime: null,
          },
        ],
      });
    });
  },
);

it.effect(
  "reads verification without a wait and recreates a domain deleted by hand",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* CustomDomain.provider.pipe(
        Effect.provideContext(services),
      );
      const first = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      mock.state.domains = [
        {
          deploymentName: props.deployment.name,
          domain: props.domain,
          requestDestination: props.requestDestination,
          creationTime: 100,
          verificationTime: 200,
        },
      ];
      const verified = yield* provider.read({
        ...lifecycle,
        olds: props,
        output: first,
      });
      expect(verified).toEqual({ ...first, verificationTime: 200 });
      yield* mock.client.deleteCustomDomain(props.deployment.name, props);
      const missing = yield* provider.read({
        ...lifecycle,
        olds: props,
        output: first,
      });
      const diff = yield* provider.diff({
        ...lifecycle,
        oldBindings: [],
        newBindings: [],
        news: props,
        olds: props,
        output: first,
      });
      const restored = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: props,
        output: missing,
      });
      expect({ missing, diff, restored }).toEqual({
        missing: undefined,
        diff: { action: "update" },
        restored: first,
      });
    });
  },
);

it.effect.each([
  { domain: "other.example.com" },
  { requestDestination: "convexSite" as const },
  { deployment: { name: "other", url: "https://other.convex.cloud" } },
  { deployment: { ...props.deployment, name: "other" } },
])(
  "refuses a changed identity in diff and reconcile before API calls $domain $requestDestination $deployment",
  (change) =>
    Effect.gen(function* () {
      const mock = mockClient();
      const services = yield* Layer.build(mock.layer);
      const provider = yield* CustomDomain.provider.pipe(
        Effect.provideContext(services),
      );
      const output = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      const news = { ...props, ...change };
      mock.client.listCustomDomains.mockClear();
      mock.client.getCanonicalUrls.mockClear();
      mock.client.createCustomDomain.mockClear();
      const expected = {
        _tag: "Failure",
        failure: {
          _tag: "CustomDomainIdentityChange",
          oldIdentity: {
            deploymentName: props.deployment.name,
            domain: props.domain,
            requestDestination: props.requestDestination,
          },
          newIdentity: {
            deploymentName: news.deployment.name,
            domain: news.domain,
            requestDestination: news.requestDestination,
          },
        },
      };
      const diff = yield* provider
        .diff({
          ...lifecycle,
          oldBindings: [],
          newBindings: [],
          news,
          olds: props,
          output,
        })
        .pipe(Effect.result);
      const reconcile = yield* provider
        .reconcile({ ...lifecycle, news, olds: props, output })
        .pipe(Effect.result);
      expect(diff).toMatchObject(expected);
      expect(reconcile).toMatchObject(expected);
      if (diff._tag === "Failure") {
        expect(diff.failure.message).toContain(props.domain);
        expect(diff.failure.message).toContain(news.domain);
        expect(diff.failure.message).toContain(props.deployment.name);
        expect(diff.failure.message).toContain(news.deployment.name);
        expect(diff.failure.message).toContain(props.requestDestination);
        expect(diff.failure.message).toContain(news.requestDestination);
        expect(diff.failure.message).toContain("second Convex.CustomDomain");
        expect(diff.failure.message).toContain("canonical: false");
        expect(diff.failure.message).toContain("verification");
      }
      expect(mock.client.listCustomDomains).not.toHaveBeenCalled();
      expect(mock.client.getCanonicalUrls).not.toHaveBeenCalled();
      expect(mock.client.createCustomDomain).not.toHaveBeenCalled();
      expect(mock.client.updateCanonicalUrl).not.toHaveBeenCalled();
      expect(mock.client.deleteCustomDomain).not.toHaveBeenCalled();
    }),
);

it.effect.each([false, true])(
  "updates only the deployment URL in place with canonical=%s",
  (canonical) =>
    Effect.gen(function* () {
      const mock = mockClient({ verificationTime: 200 });
      const services = yield* Layer.build(mock.layer);
      const provider = yield* CustomDomain.provider.pipe(
        Effect.provideContext(services),
      );
      const olds = { ...props, canonical };
      const output = yield* provider.reconcile({
        ...lifecycle,
        news: olds,
        olds: undefined,
        output: undefined,
      });
      const news = {
        ...olds,
        deployment: {
          ...props.deployment,
          url: "https://happy-otter-123.eu-west-1.convex.cloud",
        },
      };
      if (canonical)
        yield* mock.client.updateCanonicalUrl(news.deployment.url, {
          requestDestination: news.requestDestination,
          url: output.url,
        });
      const diff = yield* provider.diff({
        ...lifecycle,
        oldBindings: [],
        newBindings: [],
        news,
        olds,
        output,
      });
      const updated = yield* provider.reconcile({
        ...lifecycle,
        news,
        olds,
        output,
      });
      expect(diff).toEqual({ action: "update" });
      expect(updated).toEqual({
        ...output,
        deployment: news.deployment,
        canonicalUrl: canonical ? output.url : news.deployment.url,
      });
      expect(mock.client.createCustomDomain).toHaveBeenCalledTimes(1);
      expect(mock.client.deleteCustomDomain).not.toHaveBeenCalled();
    }),
);

it.effect(
  "deletes an owned domain on removal and tolerates a second removal",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* CustomDomain.provider.pipe(
        Effect.provideContext(services),
      );
      const output = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      yield* provider.delete({ ...lifecycle, olds: props, output });
      yield* provider.delete({ ...lifecycle, olds: props, output });
      const domains = yield* mock.client.listCustomDomains(
        props.deployment.name,
      );
      expect(domains).toEqual([]);
    });
  },
);

it.effect.each(["convexCloud", "convexSite"] as const)(
  "sets, resets and removes the canonical URL for %s only",
  (requestDestination) => {
    const mock = mockClient({ verificationTime: 200 });
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* CustomDomain.provider.pipe(
        Effect.provideContext(services),
      );
      const news = { ...props, requestDestination, canonical: true };
      const output = yield* provider.reconcile({
        ...lifecycle,
        news,
        olds: undefined,
        output: undefined,
      });
      const other =
        requestDestination === "convexCloud" ? "convexSite" : "convexCloud";
      yield* mock.client.updateCanonicalUrl(props.deployment.url, {
        requestDestination: other,
        url: "https://unrelated.example.com",
      });
      const urls = yield* mock.client.getCanonicalUrls(props.deployment.url);
      expect({ output, urls }).toEqual({
        output: {
          ...news,
          verificationTime: 200,
          url: "https://api.example.com",
          canonicalUrl: "https://api.example.com",
        },
        urls:
          requestDestination === "convexCloud"
            ? {
                convexCloudUrl: "https://api.example.com",
                convexSiteUrl: "https://unrelated.example.com",
              }
            : {
                convexCloudUrl: "https://unrelated.example.com",
                convexSiteUrl: "https://api.example.com",
              },
      });
      const off = { ...news, canonical: false };
      const diff = yield* provider.diff({
        ...lifecycle,
        oldBindings: [],
        newBindings: [],
        news: off,
        olds: news,
        output,
      });
      const reset = yield* provider.reconcile({
        ...lifecycle,
        news: off,
        olds: news,
        output,
      });
      const expectedDefault =
        requestDestination === "convexCloud"
          ? props.deployment.url
          : "https://happy-otter-123.convex.site";
      expect({ diff, reset }).toEqual({
        diff: { action: "update" },
        reset: { ...output, canonical: false, canonicalUrl: expectedDefault },
      });
      const restored = yield* provider.reconcile({
        ...lifecycle,
        news,
        olds: off,
        output: reset,
      });
      yield* provider.delete({ ...lifecycle, olds: news, output: restored });
      yield* provider.delete({ ...lifecycle, olds: news, output: restored });
      const after = yield* mock.client.getCanonicalUrls(props.deployment.url);
      const domains = yield* mock.client.listCustomDomains(
        props.deployment.name,
      );
      expect({ after, domains }).toEqual({
        after:
          requestDestination === "convexCloud"
            ? {
                convexCloudUrl: props.deployment.url,
                convexSiteUrl: "https://unrelated.example.com",
              }
            : {
                convexCloudUrl: "https://unrelated.example.com",
                convexSiteUrl: "https://happy-otter-123.convex.site",
              },
        domains: [],
      });
    });
  },
);

it.effect(
  "restores canonical drift and retains cleanup ownership after manual domain deletion",
  () => {
    const mock = mockClient({ verificationTime: 200 });
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* CustomDomain.provider.pipe(
        Effect.provideContext(services),
      );
      const news = { ...props, canonical: true };
      const first = yield* provider.reconcile({
        ...lifecycle,
        news,
        olds: undefined,
        output: undefined,
      });
      yield* mock.client.updateCanonicalUrl(props.deployment.url, {
        requestDestination: "convexCloud",
        url: "https://manual.example.com",
      });
      const observed = yield* provider.read({
        ...lifecycle,
        olds: news,
        output: first,
      });
      const diff = yield* provider.diff({
        ...lifecycle,
        oldBindings: [],
        newBindings: [],
        news,
        olds: news,
        output: observed,
      });
      const restored = yield* provider.reconcile({
        ...lifecycle,
        news,
        olds: news,
        output: observed,
      });
      expect({ observed, diff, restored }).toEqual({
        observed: { ...first, canonicalUrl: "https://manual.example.com" },
        diff: { action: "update" },
        restored: first,
      });
      yield* mock.client.deleteCustomDomain(props.deployment.name, props);
      const partial = yield* provider.read({
        ...lifecycle,
        olds: news,
        output: restored,
      });
      expect(partial).toEqual({ ...first, verificationTime: null });
      yield* provider.delete({ ...lifecycle, olds: news, output: first });
      const urls = yield* mock.client.getCanonicalUrls(props.deployment.url);
      expect(urls.convexCloudUrl).toBe(props.deployment.url);
    });
  },
);

it.effect(
  "preserves an unrelated canonical URL when the option was never enabled",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* CustomDomain.provider.pipe(
        Effect.provideContext(services),
      );
      yield* mock.client.updateCanonicalUrl(props.deployment.url, {
        requestDestination: "convexCloud",
        url: "https://unrelated.example.com",
      });
      const output = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      yield* provider.delete({ ...lifecycle, olds: props, output });
      const urls = yield* mock.client.getCanonicalUrls(props.deployment.url);
      expect({ output, urls }).toEqual({
        output: {
          ...props,
          canonical: false,
          verificationTime: null,
          url: "https://api.example.com",
          canonicalUrl: "https://unrelated.example.com",
        },
        urls: {
          convexCloudUrl: "https://unrelated.example.com",
          convexSiteUrl: "https://happy-otter-123.convex.site",
        },
      });
    });
  },
);

it.effect(
  "refuses local mode rather than claiming to configure a cloud domain",
  () =>
    Effect.gen(function* () {
      const provider = yield* CustomDomain.localProvider;
      const error = yield* provider.reconcile().pipe(Effect.flip);
      expect(error._tag).toBe("UnsupportedLocalCustomDomain");
      expect(error.message).toContain("only for cloud stages");
    }),
);

it.effect.each([401, 403])(
  "keeps authorization status %s as an error in every lifecycle phase",
  (status) => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* CustomDomain.provider.pipe(
        Effect.provideContext(services),
      );
      const news = { ...props, canonical: true };
      const output = yield* provider.reconcile({
        ...lifecycle,
        news,
        olds: undefined,
        output: undefined,
      });
      const fail = () =>
        Effect.fail(
          ConvexApiError.make({
            operation: "denied",
            code: "HttpError",
            status,
          }),
        );
      const denied = yield* CustomDomain.provider.pipe(
        Effect.provideService(ConvexClient, {
          ...mock.client,
          listCustomDomains: fail,
          updateCanonicalUrl: fail,
          deleteCustomDomain: fail,
        }),
      );
      const operations: readonly Effect.Effect<
        void,
        | Effect.Error<ReturnType<typeof denied.read>>
        | Effect.Error<ReturnType<typeof denied.reconcile>>
        | Effect.Error<ReturnType<typeof denied.delete>>
      >[] = [
        denied.read({ ...lifecycle, olds: news, output }).pipe(Effect.asVoid),
        denied
          .diff({
            ...lifecycle,
            oldBindings: [],
            newBindings: [],
            news,
            olds: news,
            output,
          })
          .pipe(Effect.asVoid),
        denied
          .reconcile({ ...lifecycle, news, olds: news, output })
          .pipe(Effect.asVoid),
        denied.delete({ ...lifecycle, olds: news, output }),
      ];
      for (const operation of operations) {
        const error = yield* operation.pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ConvexApiError", status });
      }
      const domains = yield* mock.client.listCustomDomains(
        props.deployment.name,
      );
      expect(domains).toEqual([
        {
          deploymentName: props.deployment.name,
          domain: props.domain,
          requestDestination: props.requestDestination,
          creationTime: 100,
          verificationTime: null,
        },
      ]);
    });
  },
);

it.effect("reports a matching domain with no saved output as unowned", () =>
  Effect.gen(function* () {
    const mock = mockClient();
    const services = yield* Layer.build(mock.layer);
    const provider = yield* CustomDomain.provider.pipe(
      Effect.provideContext(services),
    );
    const first = yield* provider.reconcile({
      ...lifecycle,
      news: props,
      olds: undefined,
      output: undefined,
    });
    const read = yield* provider.read({
      ...lifecycle,
      olds: props,
      output: undefined,
    });
    expect(read).toEqual(first);
    expect(Unowned.is(read)).toBe(true);
  }),
);
