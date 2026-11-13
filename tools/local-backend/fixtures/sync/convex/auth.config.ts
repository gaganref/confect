import type { AuthConfig } from "convex/server";

// The provider of `packages/test/test/fixtures/minted.ts`, whose JWKS the probe
// mints and sets before it pushes again.
export default {
  providers: [
    {
      type: "customJwt",
      issuer: "https://confect-auth.invalid",
      applicationID: "confect-test",
      algorithm: "RS256",
      jwks: process.env["TEST_AUTH_JWKS"]!,
    },
  ],
} satisfies AuthConfig;
