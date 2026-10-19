import { Component } from "@confect/core";
import spec from "./spec.js";
import { scope } from "./id.js";

const component: Component.Component<typeof spec, typeof scope, "counters" | "deliveries" | "systemIds" | "_storage" | "_scheduled_functions"> = Component.make(spec, scope, ["counters", "deliveries", "systemIds", "_storage", "_scheduled_functions"]);
export default component;
