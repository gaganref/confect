import { GroupSpec, Spec } from "@confect/core";
import email from "../email.spec.js";
import env from "../env.spec.js";
import notes_and_random_notes from "../notes_and_random/notes.spec.js";
import notes_and_random_random from "../notes_and_random/random.spec.js";
import users from "../users.spec.js";
import viewer from "../viewer.spec.js";
import workpool from "../workpool.spec.js";

const spec: Spec.Spec<{
  readonly email: GroupSpec.NamedAt<typeof email, "email">;
  readonly env: GroupSpec.NamedAt<typeof env, "env">;
  readonly notes_and_random: GroupSpec.NamedAt<GroupSpec.GroupSpec<"Convex", "notes_and_random", never, GroupSpec.NamedAt<typeof notes_and_random_notes, "notes"> | GroupSpec.NamedAt<typeof notes_and_random_random, "random">>, "notes_and_random">;
  readonly users: GroupSpec.NamedAt<typeof users, "users">;
  readonly viewer: GroupSpec.NamedAt<typeof viewer, "viewer">;
  readonly workpool: GroupSpec.NamedAt<typeof workpool, "workpool">;
}> = Spec.fromGroups({
  ["email"]: email,
  ["env"]: env,
  ["notes_and_random"]: GroupSpec.addGroupsAt(GroupSpec.make(), {
    ["notes"]: notes_and_random_notes,
    ["random"]: notes_and_random_random,
  }),
  ["users"]: users,
  ["viewer"]: viewer,
  ["workpool"]: workpool,
}) as typeof spec;

export default spec;
