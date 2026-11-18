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
 * The holders each loaded copy of the kernel installed, in install order.
 */
const holdersKey = Symbol.for("@confect/test/Egress/holders");

type Global = { [key]?: Holder; [holdersKey]?: Array<Holder> };

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
 * process, and asks each copy's in turn: a copy holds only a call its own
 * action makes, so the first that holds the call answers it. Installing the
 * same holder again adds nothing.
 */
export const install = (holder: Holder) => {
  const global = globalThis as Global;
  let holders = global[holdersKey];
  if (holders === undefined) {
    // A holder a copy from before #159 installed stays one of them.
    const found = global[key];
    const all: Array<Holder> = found === undefined ? [] : [found];
    holders = all;
    global[holdersKey] = all;
    global[key] = {
      hold: (name, input) => {
        for (const each of all) {
          const held = each.hold(name, input);
          if (held !== undefined) return held;
        }
        return undefined;
      },
    };
  }
  if (!holders.includes(holder)) holders.push(holder);
};
