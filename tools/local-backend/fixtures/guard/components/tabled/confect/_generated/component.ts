import { Component as $Component } from "@confect/core";
import $spec from "./spec.js";
import { scope as $scope } from "./id.js";

import entries from "./tables/entries.js";

const $component: $Component.Component<typeof $spec, typeof $scope, "entries" | "_storage" | "_scheduled_functions", $Component.Groups<[typeof entries]>> = $Component.contract($spec, $scope, [entries, "_storage", "_scheduled_functions"]);
export default $component;
