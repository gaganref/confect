import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Environment from "../src/internal/Environment";

declare const process: { env: Record<string, string | undefined> };

const original = process.env;
const originalSiteUrl = process.env.CONVEX_SITE_URL;

afterEach(() => {
  process.env = original;
  if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
  else process.env.CONVEX_SITE_URL = originalSiteUrl;
});

/**
 * Every way code reads `CONVEX_SITE_URL` from `process.env`.
 */
const traps = () => ({
  get: process.env.CONVEX_SITE_URL,
  has: "CONVEX_SITE_URL" in process.env,
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- The case reads the keys the environment's own trap reports.
  ownKeys: Object.keys(process.env).includes("CONVEX_SITE_URL"),
  descriptor: Object.getOwnPropertyDescriptor(process.env, "CONVEX_SITE_URL")
    ?.value as string | undefined,
  spread: { ...process.env }.CONVEX_SITE_URL,
});

describe("withSiteUrl", () => {
  it("answers its site URL through every trap, the host's left as it was, even with the host's deleted", () => {
    Environment.withSiteUrl("https://host.test", () => undefined);
    delete process.env.CONVEX_SITE_URL;
    const mounted = "https://host.test/child";
    expect(Environment.withSiteUrl(mounted, traps)).toEqual({
      get: mounted,
      has: true,
      ownKeys: true,
      descriptor: mounted,
      spread: mounted,
    });
    expect(traps()).toEqual({
      get: undefined,
      has: false,
      ownKeys: false,
      descriptor: undefined,
      spread: undefined,
    });
    expect(Environment.hostValue("CONVEX_SITE_URL")).toBeUndefined();
  });

  it("goes in again over an environment a suite put in process.env's place, which is then the host's", () => {
    Environment.withSiteUrl("https://before.test/one", () => undefined);
    const replaced = "https://replaced.test";
    process.env = { ...process.env, CONVEX_SITE_URL: replaced };
    expect(Environment.hostValue("CONVEX_SITE_URL")).toBe(replaced);
    expect(Environment.withSiteUrl(`${replaced}/two`, () => traps().get)).toBe(
      `${replaced}/two`,
    );
    expect(traps().get).toBe(replaced);
    // A value the suite sets afterwards reaches the replacement it put in.
    process.env.CONFECT_ENVIRONMENT_PROBE = "set";
    expect(Environment.hostValue("CONFECT_ENVIRONMENT_PROBE")).toBe("set");
  });
});

describe("the installed proxy", () => {
  it("uses a proxy of its own that a suite saved and put back as it is, over the host it was made for, never wrapping it again", () => {
    Environment.withSiteUrl("https://host.test/one", () => undefined);
    const saved = process.env;
    const host = Environment.hostValue("CONVEX_SITE_URL");
    process.env = { ...process.env, CONVEX_SITE_URL: "https://replaced.test" };
    expect(Environment.hostValue("CONVEX_SITE_URL")).toBe(
      "https://replaced.test",
    );
    process.env = saved;
    expect(
      Environment.withSiteUrl("https://host.test/child", () => ({
        host: Environment.hostValue("CONVEX_SITE_URL"),
        read: process.env.CONVEX_SITE_URL,
      })),
    ).toEqual({ host, read: "https://host.test/child" });
    expect(process.env).toBe(saved);
  });

  it("refuses an override, naming the version conflict, when an older copy installed the proxy", () => {
    const key = Symbol.for("@confect/test/Environment");
    const holder = globalThis as { [key]?: unknown };
    const savedState = holder[key];
    const savedEnv = process.env;
    // An older copy's state: its proxy is installed, and it records neither
    // the proxy nor the override capability.
    holder[key] = {
      lookups: new Set(),
      loading: new AsyncLocalStorage(),
      installed: true,
    };
    process.env = new Proxy({ ...savedEnv }, {});
    try {
      expect(() =>
        Environment.withSiteUrl("https://host.test/child", () => undefined),
      ).toThrow(
        Environment.SiteUrlOverrideUnsupported.make({
          capability: "@confect/test/Environment/siteUrlOverride/v1",
        }),
      );
      expect(() => Environment.requireSiteUrlOverride()).toThrow(
        /older loaded copy of @confect\/test/,
      );
    } finally {
      holder[key] = savedState;
      process.env = savedEnv;
    }
  });
});
