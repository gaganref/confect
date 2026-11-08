import { Component as $Component } from "@confect/core";
import $spec from "./spec.js";
import { scope as $scope } from "./id.js";

const $component: $Component.Component<typeof $spec, typeof $scope, "_storage" | "_scheduled_functions"> = $Component.contract($spec, $scope, ["_storage", "_scheduled_functions"]);
export default $component;
