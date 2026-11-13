import { Auth } from "@confect/core";
import app from "./app";
import env from "./env";

export default Auth.make(app, {
  providers: [
    {
      type: "customJwt",
      issuer: "https://confect-auth.invalid",
      applicationID: "confect-test",
      algorithm: "RS256",
      jwks: env.TEST_AUTH_JWKS,
    },
  ],
});
