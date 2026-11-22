import { Component as $Component } from "@confect/core";
import $spec from "./spec.js";
import { scope as $scope } from "./id.js";

const $component: $Component.Component<typeof $spec, typeof $scope, "_storage" | "_scheduled_functions", $Component.Groups<[]>> = $Component.contract($spec, $scope, ["_storage", "_scheduled_functions"]);
export default $component;

export type ComponentApi<Name extends string | undefined = string | undefined> = $Component.Api<typeof $spec, Name>;
