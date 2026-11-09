import { App } from "@confect/core";
import email from "../components/email/convex/convex.config";
import relay from "../components/relay/convex/convex.config";
import { BulkEmail } from "./bulkEmail";
import env from "./env";
import { Relay } from "./relay";
import { TransactionalEmail } from "./transactionalEmail";

export default App.make({
  env,
  components: [email, relay],
  mounts: [BulkEmail, TransactionalEmail, Relay],
});
