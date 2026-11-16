import type { RequestDestination } from "@convex-dev/platform/managementApi";
import { OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ConvexClient, type CanonicalUrls } from "./ConvexClient.js";
import type { Providers } from "./Providers.js";
import { checkpointCreate } from "./internal/Lifecycle.js";

export interface CustomDomainProps {
  readonly deployment: { readonly name: string; readonly url: string };
  readonly domain: string;
  readonly requestDestination: RequestDestination;
  /**
   * Set this domain as the canonical URL. Turning it off resets the default.
   */
  readonly canonical?: boolean;
}

export interface CustomDomainAttributes {
  readonly deployment: { readonly name: string; readonly url: string };
  readonly domain: string;
  readonly requestDestination: RequestDestination;
  readonly canonical: boolean;
  readonly verificationTime: number | null;
  /**
   * The HTTPS address of this custom domain, including before verification.
   */
  readonly url: string;
  /**
   * The current canonical URL for this destination.
   */
  readonly canonicalUrl: string;
}

export type CustomDomain = Resource<
  "Convex.CustomDomain",
  CustomDomainProps,
  CustomDomainAttributes,
  never,
  Providers
>;
export const CustomDomain = Resource<CustomDomain>("Convex.CustomDomain");

export class CustomDomainNotVisible extends Schema.TaggedError<
  CustomDomainNotVisible,
  { readonly brand: unique symbol }
>()("CustomDomainNotVisible", {
  deploymentName: Schema.String,
  domain: Schema.String,
}) {}

export class CustomDomainIdentityChange extends Schema.TaggedError<
  CustomDomainIdentityChange,
  { readonly brand: unique symbol }
>()("CustomDomainIdentityChange", {
  deploymentName: Schema.String,
  domain: Schema.String,
}) {}

const sameIdentity = (
  current: CustomDomainAttributes,
  props: CustomDomainProps,
) =>
  current.deployment.name === props.deployment.name &&
  current.deployment.url === props.deployment.url &&
  current.domain === props.domain &&
  current.requestDestination === props.requestDestination;

const canonicalUrl = (urls: CanonicalUrls, destination: RequestDestination) =>
  destination === "convexCloud" ? urls.convexCloudUrl : urls.convexSiteUrl;

export const provider = Effect.gen(function* () {
  const client = yield* ConvexClient;
  const find = Effect.fn("CustomDomain.find")(function* (
    props: CustomDomainProps,
  ) {
    const domains = yield* client
      .listCustomDomains(props.deployment.name)
      .pipe(Effect.catchTag("ConvexNotFound", () => Effect.succeed([])));
    return Option.getOrUndefined(
      Array.findFirst(
        domains,
        (domain) =>
          domain.domain === props.domain &&
          domain.requestDestination === props.requestDestination,
      ),
    );
  });
  return {
    diff: Effect.fn("CustomDomain.diff")(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return;
      if (!sameIdentity(output, news))
        return { action: "replace", deleteFirst: true };
      const current = yield* find(news);
      if (
        current === undefined ||
        output.canonical !== (news.canonical ?? false)
      )
        return { action: "update" };
      const urls = yield* client.getCanonicalUrls(news.deployment.url);
      if (
        news.canonical === true &&
        canonicalUrl(urls, news.requestDestination) !== `https://${news.domain}`
      )
        return { action: "update" };
    }),
    read: Effect.fn("CustomDomain.read")(function* ({ olds, output }) {
      if (output === undefined) {
        if (
          olds.deployment === undefined ||
          olds.domain === undefined ||
          olds.requestDestination === undefined
        )
          return;
        const current = yield* find({
          deployment: olds.deployment,
          domain: olds.domain,
          requestDestination: olds.requestDestination,
        });
        if (current !== undefined)
          return yield* new OwnedBySomeoneElse({
            message: "An existing custom domain is not owned by this resource.",
            resourceType: CustomDomain.Type,
            physicalName: olds.domain,
          });
        return;
      }
      const current = yield* find(output);
      if (current === undefined && !output.canonical) return;
      const urls = yield* client
        .getCanonicalUrls(output.deployment.url)
        .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
      if (urls === undefined) return;
      return {
        ...output,
        verificationTime: current?.verificationTime ?? null,
        canonicalUrl: canonicalUrl(urls, output.requestDestination),
      };
    }),
    reconcile: Effect.fn("CustomDomain.reconcile")(function* ({
      fqn,
      instanceId,
      news,
      output,
    }) {
      if (output === undefined) yield* checkpointCreate(fqn, instanceId, news);
      if (output !== undefined && !sameIdentity(output, news))
        return yield* CustomDomainIdentityChange.make({
          deploymentName: output.deployment.name,
          domain: output.domain,
        });
      let current = yield* find(news);
      if (current !== undefined && output === undefined)
        return yield* new OwnedBySomeoneElse({
          message: "An existing custom domain is not owned by this resource.",
          resourceType: CustomDomain.Type,
          physicalName: news.domain,
        });
      const url = `https://${news.domain}`;
      const canonical = news.canonical ?? false;
      const attributes = {
        deployment: news.deployment,
        domain: news.domain,
        requestDestination: news.requestDestination,
        canonical: canonical || (output?.canonical ?? false),
        verificationTime: current?.verificationTime ?? null,
        url,
        canonicalUrl: output?.canonicalUrl ?? url,
      };
      if (current === undefined) {
        yield* client.createCustomDomain(news.deployment.name, {
          domain: news.domain,
          requestDestination: news.requestDestination,
        });
        yield* checkpointCreate(fqn, instanceId, news, attributes);
        current = yield* find(news);
      }
      if (current === undefined)
        return yield* CustomDomainNotVisible.make({
          deploymentName: news.deployment.name,
          domain: news.domain,
        });
      yield* checkpointCreate(fqn, instanceId, news, attributes);
      let urls = yield* client.getCanonicalUrls(news.deployment.url);
      if (canonical && canonicalUrl(urls, news.requestDestination) !== url) {
        yield* client.updateCanonicalUrl(news.deployment.url, {
          requestDestination: news.requestDestination,
          url,
        });
        urls = yield* client.getCanonicalUrls(news.deployment.url);
      } else if (!canonical && output?.canonical === true) {
        yield* client.updateCanonicalUrl(news.deployment.url, {
          requestDestination: news.requestDestination,
        });
        urls = yield* client.getCanonicalUrls(news.deployment.url);
      }
      const result = {
        ...attributes,
        canonical,
        verificationTime: current.verificationTime ?? null,
        canonicalUrl: canonicalUrl(urls, news.requestDestination),
      };
      yield* checkpointCreate(fqn, instanceId, news, result);
      return result;
    }),
    delete: Effect.fn("CustomDomain.delete")(function* ({ output }) {
      if (output.canonical)
        yield* client
          .updateCanonicalUrl(output.deployment.url, {
            requestDestination: output.requestDestination,
          })
          .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
      yield* client
        .deleteCustomDomain(output.deployment.name, {
          domain: output.domain,
          requestDestination: output.requestDestination,
        })
        .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
    }),
  } satisfies Provider.ProviderServiceInput<CustomDomain>;
});

export const layer = Provider.effect(CustomDomain, provider);

export class UnsupportedLocalCustomDomain extends Schema.TaggedError<
  UnsupportedLocalCustomDomain,
  { readonly brand: unique symbol }
>()("UnsupportedLocalCustomDomain", {}) {}

export const localProvider = Effect.succeed({
  reconcile: () => Effect.fail(UnsupportedLocalCustomDomain.make({})),
  delete: () => Effect.void,
} satisfies Provider.ProviderServiceInput<CustomDomain>);

export const localLayer = Provider.effect(CustomDomain, localProvider);
