/**
 * A provider port is how an action reaches the network. On the test kernel a
 * raw `fetch` in an action dies with `BackendRefusal` `UndeclaredFetch`, so a
 * test never reaches the network and a run replays. A port call there is held
 * as a command the test answers instead. Everywhere else, in production and on
 * convex-test, the port calls its live provider.
 *
 * The kernel reaches a port through `globalThis` under
 * `Symbol.for("@confect/test/Egress")`, as `@confect/server` reaches the
 * invocation bridge, so a port defined outside this package holds the same
 * way.
 */

import * as Owner from "./Owner.js";

export interface ProviderPort<I, O> {
  readonly name: string;
  readonly call: (input: I) => Promise<O>;
}

/**
 * What the kernel installs: `hold` answers the held call's promise inside a
 * kernel action, and `undefined` anywhere else.
 */
export interface Holder {
  readonly hold: (port: string, input: unknown) => Promise<unknown> | undefined;
}

const key = Symbol.for("@confect/test/Egress");

/**
 * The holders each loaded copy of the kernel installed, keyed by the copy
 * (`Owner.self`).
 */
const holdersKey = Symbol.for("@confect/test/Egress/holders");

type Global = { [key]?: Holder; [holdersKey]?: Owner.Registry<Holder> };

/**
 * A port named `name` whose live provider is `live`. Only a call the kernel
 * does not hold reaches `live`.
 */
export const port = <I, O>(
  name: string,
  live: (input: I) => Promise<O>,
): ProviderPort<I, O> => ({
  name,
  call: (input) =>
    ((globalThis as Global)[key]?.hold(name, input) as
      | Promise<O>
      | undefined) ?? live(input),
});

/**
 * Install this copy of the kernel's holder. The holder a port reads is one per
 * process, and asks the holder of the copy that owns the innermost function
 * running now (`Owner`): a call from one copy's action into another's is held
 * by the inner action's copy. Installing again replaces this copy's holder with
 * the same one.
 */
export const install = (holder: Holder) => {
  const global = globalThis as Global;
  let holders = global[holdersKey];
  if (holders === undefined) {
    const all = Owner.registry<Holder>();
    holders = all;
    global[holdersKey] = all;
    global[key] = {
      hold: (name, input) => Owner.pick(all)?.hold(name, input),
    };
  }
  holders.set(Owner.self, holder);
};

/**
 * Whether a copy of the kernel from before #159 installed the holder ports
 * read: it holds only its own actions' calls.
 */
export const installedByOlderCopy = (): boolean => {
  const global = globalThis as Global;
  return global[key] !== undefined && global[holdersKey] === undefined;
};
