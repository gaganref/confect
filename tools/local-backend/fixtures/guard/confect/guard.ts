import { make } from "../checks";
import { verdict } from "./verdict";

export const { runs, refusals } = make("host", verdict);
