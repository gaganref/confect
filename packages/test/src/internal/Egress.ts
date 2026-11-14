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

type Global = { [key]?: Holder };

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
 * Install the kernel's holder, unless one is installed. The first answers for
 * every later one, as with `globalThis.Convex`.
 */
export const install = (holder: Holder) => {
  (globalThis as Global)[key] ??= holder;
};
