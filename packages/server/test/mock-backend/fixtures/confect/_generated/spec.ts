import { GroupSpec, Spec } from "@confect/core";
import databaseReader from "../databaseReader.spec.js";
import groups_actionCall from "../groups/actionCall.spec.js";
import groups_aliasImporter from "../groups/aliasImporter.spec.js";
import groups_cjsImporter from "../groups/cjsImporter.spec.js";
import groups_middleware from "../groups/middleware.spec.js";
import groups_middlewareHelpers from "../groups/middlewareHelpers.spec.js";
import groups_middlewareOptions from "../groups/middlewareOptions.spec.js";
import groups_middlewareOrder from "../groups/middlewareOrder.spec.js";
import groups_notes from "../groups/notes.spec.js";
import groups_random from "../groups/random.spec.js";
import groups_random_stats from "../groups/random/stats.spec.js";
import groups_runners from "../groups/runners.spec.js";
import groups_scheduling from "../groups/scheduling.spec.js";
import groups_typedErrors from "../groups/typedErrors.spec.js";
import typedErrorsNode from "../typedErrorsNode.spec.js";

const spec: Spec.Spec<{
  readonly databaseReader: GroupSpec.NamedAt<typeof databaseReader, "databaseReader">;
  readonly groups: GroupSpec.NamedAt<GroupSpec.GroupSpec<"Convex", "groups", never, GroupSpec.NamedAt<typeof groups_actionCall, "actionCall"> | GroupSpec.NamedAt<typeof groups_aliasImporter, "aliasImporter"> | GroupSpec.NamedAt<typeof groups_cjsImporter, "cjsImporter"> | GroupSpec.NamedAt<typeof groups_middleware, "middleware"> | GroupSpec.NamedAt<typeof groups_middlewareHelpers, "middlewareHelpers"> | GroupSpec.NamedAt<typeof groups_middlewareOptions, "middlewareOptions"> | GroupSpec.NamedAt<typeof groups_middlewareOrder, "middlewareOrder"> | GroupSpec.NamedAt<typeof groups_notes, "notes"> | GroupSpec.NamedAt<GroupSpec.AddGroups<typeof groups_random, GroupSpec.NamedAt<typeof groups_random_stats, "stats">>, "random"> | GroupSpec.NamedAt<typeof groups_runners, "runners"> | GroupSpec.NamedAt<typeof groups_scheduling, "scheduling"> | GroupSpec.NamedAt<typeof groups_typedErrors, "typedErrors">>, "groups">;
  readonly typedErrorsNode: GroupSpec.NamedAt<typeof typedErrorsNode, "typedErrorsNode">;
}> = Spec.fromGroups({
  ["databaseReader"]: databaseReader,
  ["groups"]: GroupSpec.addGroupsAt(GroupSpec.make(), {
    ["actionCall"]: groups_actionCall,
    ["aliasImporter"]: groups_aliasImporter,
    ["cjsImporter"]: groups_cjsImporter,
    ["middleware"]: groups_middleware,
    ["middlewareHelpers"]: groups_middlewareHelpers,
    ["middlewareOptions"]: groups_middlewareOptions,
    ["middlewareOrder"]: groups_middlewareOrder,
    ["notes"]: groups_notes,
    ["random"]: GroupSpec.addGroupsAt(groups_random, {
      ["stats"]: groups_random_stats,
    }),
    ["runners"]: groups_runners,
    ["scheduling"]: groups_scheduling,
    ["typedErrors"]: groups_typedErrors,
  }),
  ["typedErrorsNode"]: typedErrorsNode,
}) as typeof spec;

export default spec;
