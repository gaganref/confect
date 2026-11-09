import { Component as $Component } from "@confect/core";
import $spec from "./spec.js";
import { scope as $scope } from "./id.js";

import counters from "./tables/counters.js";

const $component: $Component.Component<typeof $spec, typeof $scope, "counters" | "_storage" | "_scheduled_functions", $Component.Groups<[typeof counters]>> = $Component.contract($spec, $scope, [counters, "_storage", "_scheduled_functions"]);
export default $component;
