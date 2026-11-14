import { Env } from "@confect/core";
import * as Schema from "effect/Schema";

/**
 * The required setting as a mount's modules read it while they load, from a
 * helper outside every component's folder that two components import. A
 * deployment bundles it into each mount.
 */
// oxlint-disable-next-line effecttsgo/process-env -- The fixture reads the setting natively at module scope, which a deployment evaluates per mount.
export default process.env["COMPONENT_REQUIRED"] ?? "unset";

/**
 * A value drawn once per mount as its modules load.
 */
// oxlint-disable-next-line effecttsgo/global-random -- The fixture draws natively at module scope, which a deployment does once per mount.
export const drawn = Math.random();

/**
 * Packages' exports, which every mount shares on the kernel.
 */
export const packageSchema = Schema.String;
export const packageEnv = Env;
