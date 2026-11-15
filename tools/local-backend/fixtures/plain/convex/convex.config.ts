import { defineApp } from "convex/server";
import aaa from "../aaa/convex.config.js";
import bbb from "../bbb/convex.config.js";

const app = defineApp();

app.use(aaa);
app.use(bbb);

export default app;
