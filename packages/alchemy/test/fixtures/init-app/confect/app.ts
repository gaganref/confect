import { App } from "@confect/core";
import email from "../components/email/convex/convex.config";
import { BulkEmail } from "./bulkEmail";
import env from "./env";
import { TransactionalEmail } from "./transactionalEmail";

export default App.make({
  env,
  components: [email],
  mounts: [BulkEmail, TransactionalEmail],
});
