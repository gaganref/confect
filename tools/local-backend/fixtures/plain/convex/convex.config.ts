import { defineApp } from "convex/server";
import aaa from "../aaa/convex.config.js";

const app = defineApp();

app.use(aaa);

export default app;
