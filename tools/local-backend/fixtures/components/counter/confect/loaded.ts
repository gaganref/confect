/**
 * The required setting as this component's modules read it while they load. A
 * deployment evaluates each mount's modules with that mount's environment.
 */
// oxlint-disable-next-line effecttsgo/process-env -- The fixture reads the setting natively at module scope, which is what a deployment evaluates per mount.
export default process.env["COMPONENT_REQUIRED"] ?? "unset";
