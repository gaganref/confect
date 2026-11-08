import { Component as $Component } from "@confect/core";
import $spec from "./spec.js";
import { scope as $scope } from "./id.js";

import counters from "./tables/counters.js";
import deliveries from "./tables/deliveries.js";
import systemIds from "./tables/systemIds.js";

const $component: $Component.Component<typeof $spec, typeof $scope, "counters" | "deliveries" | "systemIds" | "_storage" | "_scheduled_functions"> = $Component.contract($spec, $scope, [counters, deliveries, systemIds, "_storage", "_scheduled_functions"]);
export default $component;
