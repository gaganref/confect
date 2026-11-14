/**
 * The required setting as a mount's modules read it while they load, from a
 * helper in the app's own folder that a component imports.
 */
// oxlint-disable-next-line effecttsgo/process-env -- The fixture reads the setting natively at module scope, which a deployment evaluates per mount.
export default process.env["COMPONENT_REQUIRED"] ?? "unset";
