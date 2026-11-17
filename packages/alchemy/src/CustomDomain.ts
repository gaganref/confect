import type { RequestDestination } from "@convex-dev/platform/managementApi";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { State } from "alchemy/State/State";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Resource } from "alchemy/Resource";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ConvexClient, type CanonicalUrls } from "./ConvexClient.js";
import type { Providers } from "./Providers.js";
import { checkpointCreate, shouldAdopt } from "./internal/Lifecycle.js";

export interface CustomDomainProps {
  readonly deployment: { readonly name: string; readonly url: string };
  readonly domain: string;
  readonly requestDestination: RequestDestination;
  /**
   * Set the canonical URL after verification. Turning it off resets the default
   * only while this domain is still canonical.
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
   * The canonical URL observed when this resource last changed.
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

const identitySchema = Schema.Struct({
  deploymentName: Schema.String,
  domain: Schema.String,
  requestDestination: Schema.Literals(["convexCloud", "convexSite"]),
});

const identity = (props: CustomDomainProps) => ({
  deploymentName: props.deployment.name,
  domain: props.domain,
  requestDestination: props.requestDestination,
});

export class CustomDomainIdentityChange extends Schema.TaggedError<
  CustomDomainIdentityChange,
  { readonly brand: unique symbol }
>()("CustomDomainIdentityChange", {
  oldIdentity: identitySchema,
  newIdentity: identitySchema,
}) {
  override get message() {
    const old = this.oldIdentity;
    const next = this.newIdentity;
    return `Cannot change custom domain identity from ${old.deploymentName}/${old.domain}/${old.requestDestination} to ${next.deploymentName}/${next.domain}/${next.requestDestination}. Declare a second Convex.CustomDomain with canonical: false, deploy and configure DNS, then move canonical: true after verification and remove the old resource. For the same hostname, remove it from the old deployment before declaring it on the new one.`;
  }
}

export class ConflictingCanonicalDomains extends Schema.TaggedError<
  ConflictingCanonicalDomains,
  { readonly brand: unique symbol }
>()("ConflictingCanonicalDomains", {
  deploymentName: Schema.String,
  requestDestination: Schema.String,
  domains: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Declare only one canonical custom domain for ${this.deploymentName}/${this.requestDestination}.`;
  }
}

const validateCanonicalOwner = Effect.fn("CustomDomain.validateCanonicalOwner")(
  function* (fqn: string, props: Partial<CustomDomainProps>) {
    if (
      props.canonical !== true ||
      props.deployment === undefined ||
      props.requestDestination === undefined ||
      props.domain === undefined
    )
      return;
    const stack = yield* Effect.serviceOption(Stack);
    if (Option.isNone(stack)) return;
    for (const resource of Record.values(stack.value.resources)) {
      if (resource.Type !== CustomDomain.Type || resource.FQN === fqn) continue;
      let other: Input<CustomDomainProps> = resource.Props;
      if (!isResolved(other)) {
        const state = yield* Effect.serviceOption(State);
        if (Option.isNone(state)) continue;
        const store = yield* state.value;
        const entries = yield* Effect.forEach(
          Record.keys(Output.upstreamAny(other)),
          Effect.fnUntraced(function* (source) {
            const row = yield* store.get({
              stack: stack.value.name,
              stage: stack.value.stage,
              fqn: source,
            });
            return row === undefined ||
              row.kind === "action" ||
              row.attr === undefined
              ? undefined
              : ([source, row.attr] as const);
          }),
        );
        const upstream = Record.fromEntries(
          Array.filter(entries, (entry) => entry !== undefined),
        );
        other = yield* Output.evaluateAvailable(other, upstream).pipe(
          Effect.provideService(State, state.value),
        );
      }
      if (
        isResolved(other) &&
        other.canonical === true &&
        other.deployment.name === props.deployment.name &&
        other.requestDestination === props.requestDestination
      )
        return yield* ConflictingCanonicalDomains.make({
          deploymentName: props.deployment.name,
          requestDestination: props.requestDestination,
          domains: [props.domain, other.domain],
        });
    }
  },
);

const sameIdentity = (
  current: CustomDomainAttributes,
  props: CustomDomainProps,
) =>
  current.deployment.name === props.deployment.name &&
  current.domain === props.domain &&
  current.requestDestination === props.requestDestination;

const validateIdentity = Effect.fn("CustomDomain.validateIdentity")(function* (
  current: CustomDomainAttributes,
  props: CustomDomainProps,
) {
  if (!sameIdentity(current, props))
    return yield* CustomDomainIdentityChange.make({
      oldIdentity: identity(current),
      newIdentity: identity(props),
    });
});

const canonicalUrl = (urls: CanonicalUrls, destination: RequestDestination) =>
  destination === "convexCloud" ? urls.convexCloudUrl : urls.convexSiteUrl;

export const provider = Effect.gen(function* () {
  const client = yield* ConvexClient;
  const canonicalLocks = new Map<string, Semaphore.Semaphore>();
  const withCanonicalLock = <A, E, R>(
    deployment: CustomDomainProps["deployment"],
    destination: RequestDestination,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      const key = `${deployment.name}/${destination}`;
      let lock = canonicalLocks.get(key);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        canonicalLocks.set(key, lock);
      }
      return lock.withPermit(effect);
    });
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
    diff: Effect.fn("CustomDomain.diff")(function* ({ fqn, news, output }) {
      if (!isResolved(news)) return;
      if (output !== undefined) yield* validateIdentity(output, news);
      yield* validateCanonicalOwner(fqn, news);
      if (output === undefined) return;
      const current = yield* find(news);
      if (
        output.deployment.url !== news.deployment.url ||
        current === undefined ||
        (current.verificationTime ?? null) !== output.verificationTime ||
        output.canonical !== (news.canonical ?? false)
      )
        return { action: "update" };
      const urls = yield* client.getCanonicalUrls(news.deployment.url);
      if (
        canonicalUrl(urls, news.requestDestination) !== output.canonicalUrl ||
        (news.canonical === true &&
          current.verificationTime != null &&
          canonicalUrl(urls, news.requestDestination) !==
            `https://${news.domain}`)
      )
        return { action: "update" };
    }),
    read: Effect.fn("CustomDomain.read")(function* ({ fqn, olds, output }) {
      if (output === undefined) {
        yield* validateCanonicalOwner(fqn, olds);
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
        if (current === undefined) return;
        const urls = yield* client.getCanonicalUrls(olds.deployment.url);
        const attributes = {
          deployment: olds.deployment,
          domain: current.domain,
          requestDestination: current.requestDestination,
          canonical: olds.canonical ?? false,
          verificationTime: current.verificationTime ?? null,
          url: `https://${current.domain}`,
          canonicalUrl: canonicalUrl(urls, current.requestDestination),
        };
        return Unowned(attributes);
      }
      // Alchemy saves attempted update props before invoking reconcile.
      const canonical = output.canonical || olds.canonical === true;
      const current = yield* find(output);
      if (current === undefined && !canonical) return;
      const urls = yield* client
        .getCanonicalUrls(output.deployment.url)
        .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
      if (urls === undefined) return;
      return {
        ...output,
        canonical,
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
      if (output !== undefined) yield* validateIdentity(output, news);
      yield* validateCanonicalOwner(fqn, news);
      if (output === undefined) yield* checkpointCreate(fqn, instanceId, news);
      let current = yield* find(news);
      if (
        current !== undefined &&
        output === undefined &&
        !(yield* shouldAdopt(fqn))
      )
        return yield* new OwnedBySomeoneElse({
          message: `Custom domain ${news.domain} requires explicit adoption. Re-run with --adopt or adopt(true) to take it over.`,
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
      const urls = yield* withCanonicalLock(
        news.deployment,
        news.requestDestination,
        Effect.gen(function* () {
          let currentUrls = yield* client.getCanonicalUrls(news.deployment.url);
          if (canonical && current.verificationTime == null) {
            yield* Effect.logInfo(
              `Canonical URL for ${news.domain} is pending verification.`,
            );
          } else if (
            canonical &&
            canonicalUrl(currentUrls, news.requestDestination) !== url
          ) {
            yield* client.updateCanonicalUrl(news.deployment.url, {
              requestDestination: news.requestDestination,
              url,
            });
            currentUrls = yield* client.getCanonicalUrls(news.deployment.url);
          } else if (
            !canonical &&
            output?.canonical === true &&
            canonicalUrl(currentUrls, news.requestDestination) === url
          ) {
            yield* client.updateCanonicalUrl(news.deployment.url, {
              requestDestination: news.requestDestination,
            });
            currentUrls = yield* client.getCanonicalUrls(news.deployment.url);
          }
          return currentUrls;
        }),
      );
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
      yield* withCanonicalLock(
        output.deployment,
        output.requestDestination,
        Effect.gen(function* () {
          const urls = yield* client
            .getCanonicalUrls(output.deployment.url)
            .pipe(Effect.catchTag("ConvexNotFound", () => Effect.undefined));
          if (
            urls !== undefined &&
            canonicalUrl(urls, output.requestDestination) === output.url
          )
            yield* client
              .updateCanonicalUrl(output.deployment.url, {
                requestDestination: output.requestDestination,
              })
              .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
        }),
      );
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
>()("UnsupportedLocalCustomDomain", {}) {
  override get message() {
    return "Declare Convex.CustomDomain only for cloud stages.";
  }
}

export const localProvider = Effect.succeed({
  reconcile: () => Effect.fail(UnsupportedLocalCustomDomain.make({})),
  delete: () => Effect.void,
} satisfies Provider.ProviderServiceInput<CustomDomain>);

export const localLayer = Provider.effect(CustomDomain, localProvider);
