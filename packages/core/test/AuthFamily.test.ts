import { describe, expect, it } from "@effect/vitest";
import { AuthFamily } from "@confect/core";
import * as Result from "effect/Result";

const platform = {
  name: "platform",
  issuer: "https://platform.convex.cloud/components/auth",
  jwks: "https://platform.convex.cloud/.well-known/jwks.json",
  applicationID: "https://tenant.convex.site",
};
const billing = {
  name: "billing",
  issuer: "https://billing.convex.cloud",
  jwks: "data:text/plain;charset=utf-8;base64,e30=",
};
const platformJson = `{"name":"platform","issuer":"${platform.issuer}","jwks":"${platform.jwks}","applicationID":"${platform.applicationID}"}`;
const billingJson = `{"name":"billing","issuer":"${billing.issuer}","jwks":"${billing.jwks}"}`;
const peers = `[${platformJson},${billingJson}]`;
const service = (value: string | undefined) => ({
  family: "service",
  key: "PEER_SERVICES",
  value,
});

describe("AuthFamily.parse", () => {
  it("reads each issuer's name, URL, JWKS and optional audience", () => {
    expect(AuthFamily.parse("PEER_SERVICES", peers)).toEqual(
      Result.succeed([platform, billing]),
    );
  });

  it.each([
    ["unset", undefined, "it is not set"],
    ["empty", "", "it is empty"],
    ["blank", "  ", "it is empty"],
    ["an empty list", "[]", "it lists no issuers"],
    ["not JSON", "https://platform.convex.cloud", "JSON"],
    ["a comma list", "platform,billing", "JSON"],
    ["an object", platformJson, "array"],
    ["a list of strings", '["https://platform.convex.cloud"]', "[0]"],
    [
      "an issuer without JWKS",
      `[{"name":"platform","issuer":"${platform.issuer}"}]`,
      '[0]["jwks"]',
    ],
    [
      "an empty name",
      `[{"name":"","issuer":"${platform.issuer}","jwks":"${platform.jwks}"}]`,
      '[0]["name"]',
    ],
    [
      "a misspelled audience",
      `[{"name":"billing","issuer":"${billing.issuer}","jwks":"${billing.jwks}","applicationId":"tenant"}]`,
      '[0]["applicationId"]',
    ],
    [
      "an empty audience",
      `[{"name":"billing","issuer":"${billing.issuer}","jwks":"${billing.jwks}","applicationID":""}]`,
      '[0]["applicationID"]',
    ],
    [
      "a name listed twice",
      `[${platformJson},{"name":"platform","issuer":"${billing.issuer}","jwks":"${billing.jwks}"}]`,
      'it names "platform" twice',
    ],
    [
      "an issuer listed twice",
      `[${platformJson},{"name":"billing","issuer":"${platform.issuer}/","jwks":"${billing.jwks}"}]`,
      `it lists issuer "${platform.issuer}/" twice`,
    ],
  ])("refuses %s as a whole", (_, value, reason) => {
    const parsed = AuthFamily.parse("PEER_SERVICES", value);
    expect(Result.isFailure(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      expect(parsed.failure.key).toBe("PEER_SERVICES");
      expect(parsed.failure.reason).toContain(reason);
    }
  });
});

describe("AuthFamily.config", () => {
  it("expands a family into one Convex provider per issuer beside static providers", () => {
    expect(
      AuthFamily.config(
        [{ domain: "https://login.example.edu", applicationID: "tenant" }],
        [{ ...service(peers), algorithm: "ES256" }],
      ),
    ).toEqual([
      { domain: "https://login.example.edu", applicationID: "tenant" },
      {
        type: "customJwt",
        issuer: platform.issuer,
        jwks: platform.jwks,
        applicationID: platform.applicationID,
        algorithm: "ES256",
      },
      {
        type: "customJwt",
        issuer: billing.issuer,
        jwks: billing.jwks,
        algorithm: "ES256",
      },
    ]);
  });

  it.each([undefined, "", "[]", "platform,billing"])(
    "fails the push with the env key when the value is %j",
    (value) => {
      expect(() =>
        AuthFamily.config([], [{ ...service(value), algorithm: "ES256" }]),
      ).toThrow(
        'Provider family "service" reads its issuers from PEER_SERVICES, and PEER_SERVICES is not a valid issuer list',
      );
    },
  );

  it("refuses an issuer that a family member shares with a static provider", () => {
    expect(() =>
      AuthFamily.config(
        [
          {
            type: "customJwt",
            issuer: "platform.convex.cloud/components/auth/",
            jwks: platform.jwks,
            algorithm: "ES256",
          },
        ],
        [{ ...service(peers), algorithm: "ES256" }],
      ),
    ).toThrow(
      `Issuer "${platform.issuer}" of provider family "service" (platform) is also another provider's issuer`,
    );
  });

  it("refuses an issuer that two families share", () => {
    expect(() =>
      AuthFamily.config(
        [],
        [
          { ...service(peers), algorithm: "ES256" },
          {
            family: "partner",
            key: "PARTNERS",
            value: `[{"name":"ledger","issuer":"${billing.issuer}","jwks":"${billing.jwks}"}]`,
            algorithm: "RS256",
          },
        ],
      ),
    ).toThrow(`Issuer "${billing.issuer}" of provider family "service"`);
  });

  it("keeps two static providers on one issuer, as Convex allows", () => {
    const statics = [
      { domain: "https://login.example.edu", applicationID: "tenant" },
      { domain: "https://login.example.edu", applicationID: "staff" },
    ];
    expect(AuthFamily.config(statics, [])).toEqual(statics);
  });
});

describe("AuthFamily.providers", () => {
  it("lists each family member with its family, name and audience", () => {
    expect(
      AuthFamily.providers(
        [{ issuer: "https://login.example.edu", audience: "tenant" }],
        [service(peers)],
      ),
    ).toEqual([
      { issuer: "https://login.example.edu", audience: "tenant" },
      {
        issuer: platform.issuer,
        audience: platform.applicationID,
        family: "service",
        name: "platform",
      },
      { issuer: billing.issuer, family: "service", name: "billing" },
    ]);
  });

  it.each([undefined, "", "[]", "{"])(
    "lists no member of a family whose value is %j",
    (value) => {
      const person = { issuer: "https://login.example.edu", family: "person" };
      expect(AuthFamily.providers([person], [service(value)])).toEqual([
        person,
      ]);
    },
  );
});

describe("AuthFamily.lookup", () => {
  const listed = AuthFamily.providers(
    [{ issuer: "https://login.example.edu", audience: "tenant" }],
    [service(peers)],
  );

  it.each([
    platform.issuer,
    `${platform.issuer}/`,
    "platform.convex.cloud/components/auth",
  ])("finds the one provider for %s, as Convex matches it", (issuer) => {
    expect(AuthFamily.lookup(listed, issuer)).toEqual({
      _tag: "Provider",
      provider: {
        issuer: platform.issuer,
        audience: platform.applicationID,
        family: "service",
        name: "platform",
      },
    });
  });

  it("finds nothing for an unknown issuer", () => {
    expect(AuthFamily.lookup(listed, "https://stranger.convex.cloud")).toEqual({
      _tag: "Unknown",
    });
  });

  it("returns every provider of an issuer that two providers share", () => {
    const shared = [
      { issuer: "https://login.example.edu", audience: "tenant" },
      { issuer: "https://login.example.edu/", audience: "staff" },
      { issuer: "https://other.example.edu" },
    ];
    expect(AuthFamily.lookup(shared, "https://login.example.edu")).toEqual({
      _tag: "Shared",
      providers: [shared[0], shared[1]],
    });
  });
});
