import { Component as $Component } from "@confect/core";
import $spec from "./spec.js";
import { scope as $scope } from "./id.js";

import batches from "./tables/batches.js";
import emails from "./tables/emails.js";

const $component: $Component.Component<typeof $spec, typeof $scope, "batches" | "emails" | "_storage" | "_scheduled_functions", $Component.Groups<[typeof batches, typeof emails]>> = $Component.contract($spec, $scope, [batches, emails, "_storage", "_scheduled_functions"]);
export default $component;
