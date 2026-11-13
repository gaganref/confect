import { Refs } from "@confect/core";
import spec from "./spec.js";

const refs: Refs.FromSpec<typeof spec> = Refs.make(spec);

export default refs;
