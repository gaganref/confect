import type { TestConfect } from "@confect/test";
import schema from "../../components/counter/convex/schema.js";

export function register(
  t: { readonly registerComponent: TestConfect.RegisterComponent },
  name: string,
): void {
  t.registerComponent(
    name,
    schema,
    import.meta.glob("../../components/counter/convex/**/*.ts"),
  );
}
