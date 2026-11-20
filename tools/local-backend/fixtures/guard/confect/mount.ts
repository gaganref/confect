import { Mount } from "@confect/core";
import GuardedComponent from "../components/guarded/client";

export const Guarded = Mount.make(GuardedComponent, { name: "guarded" });
