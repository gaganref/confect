/**
 * What a target's `confect/verdict.ts` declares: the version its functions
 * report, and the entry whose push analysis its checks refuse, if any.
 */
export interface Verdict {
  readonly version: number;
  readonly refuse: "none" | "isolate" | "node" | "router";
}

// Convex's isolate defines `process` with `env` alone; its Node executor is Node.
const runtime = (): "isolate" | "node" =>
  typeof process.versions?.node === "string" ? "node" : "isolate";

/**
 * A target's push check logic, made at the module scope of its
 * `confect/guard.ts`: `refusals` answers each section's check, refusing in the
 * runtime or entry `verdict` names, and `runs` counts the checks it ran in this
 * module graph.
 */
export const make = (target: string, verdict: Verdict) => {
  const runs = { count: 0 };
  const refusals = (check: "functions" | "router"): ReadonlyArray<string> => {
    runs.count++;
    const refused =
      check === "router"
        ? verdict.refuse === "router"
        : verdict.refuse === runtime();
    return refused
      ? [
          `${target} declaration "refused-in-${verdict.refuse}" in confect/verdict.ts is refused`,
        ]
      : [];
  };
  return { runs, refusals };
};
