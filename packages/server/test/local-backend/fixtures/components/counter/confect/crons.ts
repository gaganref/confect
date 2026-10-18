import { CronJob, CronJobs } from "@confect/server";
import * as Duration from "effect/Duration";
import refs from "./_generated/refs";

export default CronJobs.make().add(
  CronJob.make(
    "counter-tick",
    Duration.seconds(5),
    refs.internal.counter.tick,
    {},
  ),
);
