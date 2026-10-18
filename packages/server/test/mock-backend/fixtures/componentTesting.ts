import type { TestConfect } from "../../../../test/src";
import schema from "../../../../cli/test/fixtures/authored-component/convex/schema";

export const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "http.ts": () =>
    import("./components/counter/http").then(({ makeHttp }) => ({
      default: makeHttp(),
    })),
  "counter.ts": () =>
    import("../../../../cli/test/fixtures/authored-component/convex/counter"),
};

export const register = (
  registerComponent: TestConfect.RegisterComponent,
  name: string,
) => registerComponent(name, schema, modules);
