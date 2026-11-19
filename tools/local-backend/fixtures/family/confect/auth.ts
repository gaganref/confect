import { Auth } from "@confect/core";
import app, { env } from "./app";

export default Auth.make(app, {
  providers: [
    {
      type: "customJwt",
      issuer: "https://confect-auth.invalid",
      applicationID: "confect-test",
      algorithm: "RS256",
      jwks: "data:application/json;base64,eyJrZXlzIjpbXX0=",
      family: "person",
    },
    Auth.family({
      family: "service",
      issuers: env.PEER_SERVICES,
      algorithm: "RS256",
    }),
  ],
});
