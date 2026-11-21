import { AsyncLocalStorage } from "node:async_hooks";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

/**
 * Which database schemas a component's modules registered push checks for, so a
 * test backend finds a component's checks from its own modules, whatever kit
 * registered it and whether or not any entry runs them.
 *
 * `@confect/server`'s `PushCheck.register` tells every observer in the set
 * under `Symbol.for("@confect/server/PushCheck/observers/v1")` of each schema
 * it registers a check for. The observer keeps it in two places.
 *
 * - **On the module that registered it**, in the module graph of the test runner,
 *   when the runner keeps one: Vitest's module runner, whose `evaluatedModules`
 *   holds a node per evaluated module with its imports. The registering module
 *   is the innermost one on the registration's stack whose evaluation has not
 *   finished, which is the module whose top-level code registers, never a
 *   helper it calls that loaded before. A component then owns every schema
 *   registered by any module its loaded modules import, at any depth, so two
 *   entries that import one provider both name its schema, whichever evaluated
 *   it, inside a layer or before. A module the runner evaluates again, after
 *   `vi.resetModules`, is a new node, so a stale copy's schema never reaches
 *   it.
 * - **On the load that ran it**: while a module loads under {@link record}, an
 *   async context carries the load's own set into the module's code and every
 *   module it imports first, and the load's namespace keeps those schemas. This
 *   serves a runner that keeps no module graph.
 */

const observersKey = Symbol.for("@confect/server/PushCheck/observers/v1");

/**
 * One module of the test runner's graph, as Vite's module runner keeps it.
 */
interface ModuleNode {
  readonly imports: ReadonlySet<string>;
  readonly evaluated: boolean;
  readonly exports: unknown;
}

/**
 * The test runner's module graph, by resolved module id, which a module's
 * frames name.
 */
type ModuleGraph = ReadonlyMap<string, ModuleNode>;

/**
 * Vitest's module graph for this worker, or none outside Vitest or for a runner
 * that keeps none.
 */
const moduleGraph = (): ModuleGraph | undefined => {
  const map = (
    globalThis as {
      readonly __vitest_worker__?: {
        readonly evaluatedModules?: { readonly idToModuleMap?: unknown };
      };
    }
  ).__vitest_worker__?.evaluatedModules?.idToModuleMap;
  return map instanceof Map ? (map as ModuleGraph) : undefined;
};

/**
 * The schemas the loads running now registered checks for, innermost first.
 */
const loading = new AsyncLocalStorage<Set<object>>();

/**
 * The schemas each module namespace's load registered checks for.
 */
const traced = new WeakMap<object, Set<object>>();

/**
 * The schemas each module of the runner's graph registered checks for, as its
 * own top-level code ran.
 */
const registeredBy = new WeakMap<ModuleNode, Set<object>>();

/**
 * The file of a stack frame, as the runner's graph keys its module.
 */
const locationOf = (frame: string): string | undefined =>
  /\((.+):\d+:\d+\)$/.exec(frame)?.[1] ??
  /^\s*at (?:async )?(.+):\d+:\d+$/.exec(frame)?.[1];

/**
 * The module of `graph` whose evaluation registers now: the innermost module
 * still evaluating among the frames below `PushCheck.register`, which calls the
 * observer that calls this. The frames of this module come first, then
 * `register`'s, and neither is the registering module, though a graph a module
 * reset left behind may hold an unevaluated node for either file.
 */
const registering = (graph: ModuleGraph): ModuleNode | undefined => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 200;
  const stack = new Error("push check registration").stack ?? "";
  Error.stackTraceLimit = limit;
  const frames = Arr.filter(
    Arr.map(Str.split(stack, "\n"), locationOf),
    (location) => location !== undefined,
  );
  const own = frames[0];
  let below = 0;
  while (below < frames.length && frames[below] === own) below++;
  // The next frame is `register`'s.
  for (const location of frames.slice(below + 1)) {
    const node = graph.get(location);
    if (node !== undefined && !node.evaluated) return node;
  }
  return undefined;
};

const observe = (schema: object) => {
  loading.getStore()?.add(schema);
  const graph = moduleGraph();
  const node = graph === undefined ? undefined : registering(graph);
  if (node === undefined) return;
  const kept = registeredBy.get(node);
  if (kept === undefined) registeredBy.set(node, new Set([schema]));
  else kept.add(schema);
};

/**
 * Add this copy's observer to the process's set, once.
 */
const install = () => {
  const holder = globalThis as {
    [observersKey]?: Set<(schema: object) => void>;
  };
  (holder[observersKey] ??= new Set()).add(observe);
};

install();

const isNamespace = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/**
 * Run `load`, a module loader, keeping the schemas its load registers checks
 * for on the namespace it resolves to. A nested load keeps its own and passes
 * them to the load around it, as a module's imports load inside its own.
 */
export const record = <A>(load: () => Promise<A>): Promise<A> => {
  const schemas = new Set<object>();
  const outer = loading.getStore();
  return loading
    .run(schemas, () => Promise.resolve().then(load))
    .then((namespace) => {
      if (isNamespace(namespace) && schemas.size > 0) {
        const kept = traced.get(namespace);
        if (kept === undefined) traced.set(namespace, schemas);
        else for (const schema of schemas) kept.add(schema);
      }
      if (outer !== undefined) for (const schema of schemas) outer.add(schema);
      return namespace;
    });
};

/**
 * The schemas registered by every module the graph shows `namespaces` import,
 * at any depth, themselves included.
 */
const importedSchemas = (
  graph: ModuleGraph,
  namespaces: ReadonlyArray<object>,
  found: Set<object>,
) => {
  const wanted = new Set<unknown>(namespaces);
  const pending: Array<ModuleNode> = [];
  for (const node of graph.values())
    if (wanted.has(node.exports)) pending.push(node);
  const visited = new Set<ModuleNode>();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (visited.has(node)) continue;
    visited.add(node);
    for (const schema of registeredBy.get(node) ?? []) found.add(schema);
    for (const id of node.imports) {
      const imported = graph.get(id);
      if (imported !== undefined && !visited.has(imported))
        pending.push(imported);
    }
  }
};

/**
 * The schemas registered for checks by the modules `namespaces` loaded, or by
 * any module they import, in the order first found.
 */
export const schemasOf = (
  namespaces: Iterable<unknown>,
): ReadonlyArray<object> => {
  const found = new Set<object>();
  const loaded: Array<object> = [];
  for (const namespace of namespaces) {
    if (!isNamespace(namespace)) continue;
    loaded.push(namespace);
    for (const schema of traced.get(namespace) ?? []) found.add(schema);
  }
  const graph = moduleGraph();
  if (graph !== undefined) importedSchemas(graph, loaded, found);
  return [...found];
};
