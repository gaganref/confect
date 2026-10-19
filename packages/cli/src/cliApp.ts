import * as Command from "effect/cli/Command";
import packageJson from "../package.json" with { type: "json" };
import { confect } from "./confect.js";

export const cliApp = Command.run(confect, {
  version: packageJson.version,
});
