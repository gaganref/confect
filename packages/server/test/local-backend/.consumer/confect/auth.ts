import { Auth } from "@confect/core";
import app from "./app.js";
export default Auth.make(app, {
  providers: [
    { domain: "https://login.example.edu", applicationID: "consumer" },
  ],
});
