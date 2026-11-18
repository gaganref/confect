/**
 * The required setting as this component's modules read it while they load. A
 * deployment evaluates each mount's modules with that mount's environment.
 */
// oxlint-disable-next-line effecttsgo/process-env -- The fixture reads the setting natively at module scope, which is what a deployment evaluates per mount.
export default process.env["COMPONENT_REQUIRED"] ?? "unset";

/**
 * A value this component's modules draw while they load, once per mount.
 */
// oxlint-disable-next-line effecttsgo/global-random -- The fixture draws natively at module scope, which a deployment does once per mount.
export const drawn = Math.random();
