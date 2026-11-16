import { it, expect, expectTypeOf } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Record from "effect/Record";
import * as Array from "effect/Array";

import * as Deployment from "@confect/alchemy/Deployment";
import { deployment, lifecycle, mockClient } from "./fixtures/ConvexClient";

const props: Deployment.DeploymentProps = {
  projectId: 1,
  type: "prod",
  reference: "example",
};
const attrs: Deployment.DeploymentAttributes = {
  projectId: 1,
  type: "prod",
  name: "happy-otter-123",
  reference: "example",
  region: "aws-us-east-1",
  url: "https://happy-otter-123.convex.cloud",
};

it.effect(
  "creates a cloud dev deployment with an expiry in milliseconds",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* Deployment.provider.pipe(
        Effect.provideContext(services),
      );
      const news = {
        ...props,
        type: "dev" as const,
        expiresAt: 1_800_000_000_000,
      };
      const created = yield* provider.reconcile({
        ...lifecycle,
        news,
        olds: undefined,
        output: undefined,
      });
      expect(mock.client.createDeployment).toHaveBeenCalledWith(1, {
        type: "dev",
        reference: "example",
        expiresAt: 1_800_000_000_000,
      });
      expect(created).toMatchObject({
        name: attrs.name,
        expiresAt: 1_800_000_000_000,
      });
    });
  },
);

it.effect.each([{ expiresAt: null }, { expiresAt: 1_800_000_000_000 }])(
  "sets or extends a dev expiry in place from $expiresAt and repairs live drift",
  ({ expiresAt }) => {
    const mock = mockClient();
    mock.state.deployments = [deployment({ deploymentType: "dev", expiresAt })];
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* Deployment.provider.pipe(
        Effect.provideContext(services),
      );
      const olds = { ...props, type: "dev" as const, expiresAt };
      const news = { ...olds, expiresAt: 1_800_003_600_000 };
      const input = {
        ...lifecycle,
        news,
        olds,
        output: { ...attrs, type: "dev" as const, expiresAt },
        oldBindings: [],
        newBindings: [],
      };
      const diff = yield* provider.diff(input);
      expect(diff).toEqual({ action: "update" });
      const updated = yield* provider.reconcile(input);
      expect(updated).toMatchObject({
        name: attrs.name,
        expiresAt: 1_800_003_600_000,
      });
      expect(mock.client.updateDeployment).toHaveBeenCalledWith(attrs.name, {
        reference: "example",
        expiresAt: 1_800_003_600_000,
      });
      const unchanged = yield* provider.diff({ ...input, output: updated });
      expect(unchanged).toBeUndefined();
      mock.state.deployments = [
        deployment({ deploymentType: "dev", expiresAt: 1_800_007_200_000 }),
      ];
      const drift = yield* provider.diff({ ...input, output: updated });
      expect(drift).toEqual({ action: "update" });
      const repaired = yield* provider.reconcile({ ...input, output: updated });
      expect(repaired).toMatchObject({
        name: attrs.name,
        expiresAt: 1_800_003_600_000,
      });
      expect(mock.client.createDeployment).not.toHaveBeenCalled();
      expect(mock.client.deleteDeployment).not.toHaveBeenCalled();
    });
  },
);

it.effect.each([
  { change: "remove", expiry: {} },
  { change: "clear", expiry: { expiresAt: null } },
])("clears a managed expiry in place on $change", ({ expiry }) => {
  const mock = mockClient();
  mock.state.deployments = [
    deployment({ deploymentType: "dev", expiresAt: 1_800_000_000_000 }),
  ];
  return Effect.gen(function* () {
    const services = yield* Layer.build(mock.layer);
    const provider = yield* Deployment.provider.pipe(
      Effect.provideContext(services),
    );
    const news = { ...props, type: "dev" as const, ...expiry };
    const input = {
      ...lifecycle,
      news,
      olds: { ...props, type: "dev" as const, expiresAt: 1_800_000_000_000 },
      output: { ...attrs, type: "dev" as const, expiresAt: 1_800_000_000_000 },
      oldBindings: [],
      newBindings: [],
    };
    const diff = yield* provider.diff(input);
    expect(diff).toEqual({ action: "update" });
    const cleared = yield* provider.reconcile(input);
    expect(cleared).toMatchObject({ name: attrs.name, expiresAt: null });
    expect(mock.client.updateDeployment).toHaveBeenCalledWith(attrs.name, {
      reference: "example",
      expiresAt: null,
    });
    const unchanged = yield* provider.diff({ ...input, output: cleared });
    expect(unchanged).toBeUndefined();
    expect(mock.client.createDeployment).not.toHaveBeenCalled();
    expect(mock.client.deleteDeployment).not.toHaveBeenCalled();
  });
});

it.effect(
  "preserves a preview's default expiry when the prop was never managed",
  () => {
    const mock = mockClient();
    mock.state.deployments = [
      deployment({ deploymentType: "preview", expiresAt: 1_800_000_000_000 }),
    ];
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* Deployment.provider.pipe(
        Effect.provideContext(services),
      );
      const news = { ...props, type: "preview" as const };
      const input = {
        ...lifecycle,
        news,
        olds: news,
        output: { ...attrs, type: "preview" as const },
        oldBindings: [],
        newBindings: [],
      };
      const diff = yield* provider.diff(input);
      expect(diff).toBeUndefined();
      const preserved = yield* provider.reconcile(input);
      expect(preserved).toMatchObject({
        name: attrs.name,
        expiresAt: 1_800_000_000_000,
      });
      expect(mock.client.updateDeployment).not.toHaveBeenCalled();
    });
  },
);

it.effect("creates a deployment with the requested class", () => {
  const mock = mockClient();
  return Effect.gen(function* () {
    const services = yield* Layer.build(mock.layer);
    const provider = yield* Deployment.provider.pipe(
      Effect.provideContext(services),
    );
    const news = { ...props, class: "s256" as const };
    const created = yield* provider.reconcile({
      ...lifecycle,
      news,
      olds: undefined,
      output: undefined,
    });
    expect(mock.client.createDeployment).toHaveBeenCalledWith(1, {
      type: "prod",
      reference: "example",
      class: "s256",
    });
    expect(created).toMatchObject({ name: attrs.name, class: "s256" });
  });
});

it.effect("changes a cloud class in place, including live class drift", () => {
  const mock = mockClient();
  mock.state.deployments = [deployment({ class: "s16" })];
  return Effect.gen(function* () {
    const services = yield* Layer.build(mock.layer);
    const provider = yield* Deployment.provider.pipe(
      Effect.provideContext(services),
    );
    const news = { ...props, class: "s256" as const };
    const input = {
      ...lifecycle,
      news,
      olds: { ...props, class: "s16" as const },
      output: { ...attrs, class: "s16" },
      oldBindings: [],
      newBindings: [],
    };
    const diff = yield* provider.diff(input);
    expect(diff).toEqual({ action: "update" });
    const updated = yield* provider.reconcile(input);
    expect(updated).toMatchObject({ name: attrs.name, class: "s256" });
    const unchanged = yield* provider.diff({ ...input, output: updated });
    expect(unchanged).toBeUndefined();
    mock.state.deployments = [deployment({ class: "d1024" })];
    const drift = yield* provider.diff({ ...input, output: updated });
    expect(drift).toEqual({ action: "update" });
    const repaired = yield* provider.reconcile({ ...input, output: updated });
    expect(repaired).toMatchObject({ name: attrs.name, class: "s256" });
    expect(mock.client.createDeployment).not.toHaveBeenCalled();
    expect(mock.client.deleteDeployment).not.toHaveBeenCalled();
  });
});

it("accepts only platform deployment classes at the public constructor", () => {
  expectTypeOf<Deployment.DeploymentProps["class"]>().toEqualTypeOf<
    "s16" | "s256" | "d1024" | "d2048" | undefined
  >();
  const unknown = { ...props, class: "unknown-class" as const };
  // @ts-expect-error The public constructor rejects unknown deployment classes.
  void Deployment.Deployment("Deployment", unknown);
});

it.effect(
  "reconciles repeatedly and repairs reference drift without replacement",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      return yield* Effect.gen(function* () {
        const provider = yield* Deployment.provider;
        const first = yield* provider.reconcile({
          ...lifecycle,
          news: props,
          olds: undefined,
          output: undefined,
        });
        yield* provider.reconcile({
          ...lifecycle,
          news: props,
          olds: props,
          output: first,
        });
        expect(mock.client.createDeployment).toHaveBeenCalledTimes(1);
        expect(mock.client.updateDeployment).not.toHaveBeenCalled();
        mock.state.deployments = [deployment({ reference: "drift" })];
        const observed = yield* provider.read({
          ...lifecycle,
          olds: props,
          output: first,
        });
        expect(observed?.reference).toBe("drift");
        const diff2 = yield* provider.diff({
          ...lifecycle,
          olds: props,
          news: props,
          output: first,
          oldBindings: [],
          newBindings: [],
        });
        expect(diff2).toEqual({ action: "update" });
        const updated = yield* provider.reconcile({
          ...lifecycle,
          news: props,
          olds: props,
          output: observed,
        });
        expect(updated.reference).toBe("example");
        expect(mock.client.updateDeployment).toHaveBeenCalledTimes(1);
        expect(mock.client.deleteDeployment).not.toHaveBeenCalled();
      }).pipe(Effect.provideContext(services));
    });
  },
);

it.effect(
  "requires adoption of reference matches and rejects duplicate references",
  () => {
    const mock = mockClient();
    mock.state.deployments = [deployment()];
    return Effect.gen(function* () {
      const services2 = yield* Layer.build(mock.layer);
      return yield* Effect.gen(function* () {
        const provider = yield* Deployment.provider;
        const found = yield* provider.read({
          ...lifecycle,
          olds: props,
          output: undefined,
        });
        expect(Unowned.is(found)).toBe(true);
        const collision = yield* Effect.flip(
          provider.reconcile({
            ...lifecycle,
            news: props,
            olds: undefined,
            output: undefined,
          }),
        );
        expect(collision._tag).toBe("OwnedBySomeoneElse");
        yield* provider.reconcile({
          ...lifecycle,
          news: props,
          olds: undefined,
          output: found,
        });
        mock.state.deployments.push(
          deployment({ name: "other-deployment-456" }),
        );
        const ambiguous = yield* Effect.flip(
          provider.read({ ...lifecycle, olds: props, output: undefined }),
        );
        expect(ambiguous._tag).toBe("AmbiguousDeployment");
        expect(mock.client.createDeployment).not.toHaveBeenCalled();
      }).pipe(Effect.provideContext(services2));
    });
  },
);

it.effect("never replaces data when project, type, or region changes", () => {
  const mock = mockClient();
  mock.state.deployments = [deployment()];
  return Effect.gen(function* () {
    const services3 = yield* Layer.build(mock.layer);
    return yield* Effect.gen(function* () {
      const provider = yield* Deployment.provider;
      for (const changed of [
        { projectId: 2 },
        { type: "dev" as const },
        { region: "aws-eu-west-1" as const },
      ]) {
        const error = yield* Effect.flip(
          provider.reconcile({
            ...lifecycle,
            news: { ...props, ...changed },
            olds: props,
            output: attrs,
          }),
        );
        expect(error._tag).toBe("DeploymentIdentityChange");
      }
      expect(mock.client.createDeployment).not.toHaveBeenCalled();
      expect(mock.client.deleteDeployment).not.toHaveBeenCalled();
      expect(mock.client.updateDeployment).not.toHaveBeenCalled();
      yield* provider.delete({ ...lifecycle, olds: props, output: attrs });
      yield* provider.delete({ ...lifecycle, olds: props, output: attrs });
      const read2 = yield* provider.read({
        ...lifecycle,
        olds: props,
        output: attrs,
      });
      expect(read2).toBeUndefined();
    }).pipe(Effect.provideContext(services3));
  });
});

it.effect(
  "observes missing deployments and unsafe live identity drift during planning",
  () => {
    const mock = mockClient();
    mock.state.deployments = [deployment()];
    return Effect.gen(function* () {
      const services4 = yield* Layer.build(mock.layer);
      return yield* Effect.gen(function* () {
        const provider = yield* Deployment.provider;
        const input = {
          ...lifecycle,
          olds: props,
          news: props,
          output: attrs,
          oldBindings: [],
          newBindings: [],
        };
        const diff2 = yield* provider.diff(input);
        expect(diff2).toBeUndefined();
        mock.state.deployments = [];
        const diff3 = yield* provider.diff(input);
        expect(diff3).toEqual({ action: "update" });
        mock.state.deployments = [deployment({ projectId: 2 })];
        expect((yield* Effect.flip(provider.diff(input)))._tag).toBe(
          "DeploymentIdentityChange",
        );
        expect(mock.client.createDeployment).not.toHaveBeenCalled();
        expect(mock.client.updateDeployment).not.toHaveBeenCalled();
      }).pipe(Effect.provideContext(services4));
    });
  },
);

it.effect(
  "uses deterministic references for recovery, never default deployments",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services5 = yield* Layer.build(mock.layer);
      return yield* Effect.gen(function* () {
        const provider = yield* Deployment.provider;
        const news = { projectId: 1, type: "prod" as const };
        const first = yield* provider.reconcile({
          ...lifecycle,
          news,
          olds: undefined,
          output: undefined,
        });
        expect(first.reference).toMatch(/^confect-deployment-/);
        const found = yield* provider.read({
          ...lifecycle,
          olds: news,
          output: undefined,
        });
        expect(found?.reference).toBe(first.reference);
        expect(Unowned.is(found)).toBe(true);
        const error = yield* Effect.flip(
          provider.reconcile({
            ...lifecycle,
            news,
            olds: undefined,
            output: undefined,
          }),
        );
        expect(error._tag).toBe("OwnedBySomeoneElse");
        expect(mock.client.createDeployment).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provideContext(services5));
    });
  },
);

it.effect.each(
  Array.flatMap(
    [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1],
    (expiresAt) =>
      Array.map(
        ["create", "update", "plan create", "plan update"] as const,
        (operation) => ({ expiresAt, operation }),
      ),
  ),
)(
  "rejects unsafe expiry $expiresAt before any API call on $operation",
  ({ expiresAt, operation }) => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* Deployment.provider.pipe(
        Effect.provideContext(services),
      );
      const input = {
        ...lifecycle,
        news: { ...props, expiresAt },
        olds: props,
        output:
          operation === "create" || operation === "plan create"
            ? undefined
            : { ...attrs, expiresAt: 1_800_000_000_000 },
        oldBindings: [],
        newBindings: [],
      };
      const result = yield* (
        operation === "plan create" || operation === "plan update"
          ? provider.diff(input).pipe(Effect.asVoid)
          : provider.reconcile(input).pipe(Effect.asVoid)
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          _tag: "InvalidDeploymentExpiry",
          requested: String(expiresAt),
        });
      for (const method of Record.values(mock.client))
        expect(method).not.toHaveBeenCalled();
    });
  },
);
