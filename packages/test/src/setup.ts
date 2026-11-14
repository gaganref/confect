/**
 * A Vitest setup file for tests that run on the test kernel
 * (`TestConfect.layer`'s `target: "kernel"`). List it first in `setupFiles`.
 *
 * It guards the host APIs Convex refuses or lacks before any test module loads,
 * so a reference a module takes when it is imported is the guard, and a kernel
 * query or mutation that calls it is refused. A reference taken before this
 * file runs, by an earlier setup file or a global setup, stays the host's.
 * Outside a kernel function every guard calls the host's function.
 *
 * @module
 */
import * as IoBans from "./internal/IoBans.js";

IoBans.install();
