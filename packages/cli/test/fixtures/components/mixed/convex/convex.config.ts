import workpool from "@convex-dev/workpool/convex.config";
import { defineApp } from "convex/server";
import limiter from "../limiter/convex.config";
import notes from "../components/notes/convex/convex.config";
import waitlist from "../components/waitlist/convex/convex.config";

const app = defineApp();
app.use(limiter);
app.use(notes);
app.use(waitlist);
app.use(workpool);

export default app;
