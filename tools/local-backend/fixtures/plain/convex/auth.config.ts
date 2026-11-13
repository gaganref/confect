// The provider of `../../minted.ts`, so the plain fixture verifies the tokens
// the JWT suite mints. Its JWKS is the environment's, which the suite sets.
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
};
