import { GroupSpec, Spec } from "@confect/core";
import groups_cacheControl from "../groups/cacheControl.spec.js";
import groups_cacheStubbed from "../groups/cacheStubbed.spec.js";
import groups_callbacks from "../groups/callbacks.spec.js";
import groups_commitTs from "../groups/commitTs.spec.js";
import groups_componentAuthoring from "../groups/componentAuthoring.spec.js";
import groups_components from "../groups/components.spec.js";
import groups_metadata from "../groups/metadata.spec.js";
import groups_mounts from "../groups/mounts.spec.js";
import groups_nativeComponents from "../groups/nativeComponents.spec.js";
import groups_pagination from "../groups/pagination.spec.js";
import groups_reserved from "../groups/reserved.spec.js";
import groups_scheduling from "../groups/scheduling.spec.js";
import groups_storage from "../groups/storage.spec.js";
import groups_transactions from "../groups/transactions.spec.js";
import metadataNode from "../metadataNode.spec.js";

const spec: Spec.Spec<{
  readonly groups: GroupSpec.NamedAt<GroupSpec.GroupSpec<"Convex", "groups", never, GroupSpec.NamedAt<typeof groups_cacheControl, "cacheControl"> | GroupSpec.NamedAt<typeof groups_cacheStubbed, "cacheStubbed"> | GroupSpec.NamedAt<typeof groups_callbacks, "callbacks"> | GroupSpec.NamedAt<typeof groups_commitTs, "commitTs"> | GroupSpec.NamedAt<typeof groups_componentAuthoring, "componentAuthoring"> | GroupSpec.NamedAt<typeof groups_components, "components"> | GroupSpec.NamedAt<typeof groups_metadata, "metadata"> | GroupSpec.NamedAt<typeof groups_mounts, "mounts"> | GroupSpec.NamedAt<typeof groups_nativeComponents, "nativeComponents"> | GroupSpec.NamedAt<typeof groups_pagination, "pagination"> | GroupSpec.NamedAt<typeof groups_reserved, "reserved"> | GroupSpec.NamedAt<typeof groups_scheduling, "scheduling"> | GroupSpec.NamedAt<typeof groups_storage, "storage"> | GroupSpec.NamedAt<typeof groups_transactions, "transactions">>, "groups">;
  readonly metadataNode: GroupSpec.NamedAt<typeof metadataNode, "metadataNode">;
}> = Spec.fromGroups({
  ["groups"]: GroupSpec.addGroupsAt(GroupSpec.make(), {
    ["cacheControl"]: groups_cacheControl,
    ["cacheStubbed"]: groups_cacheStubbed,
    ["callbacks"]: groups_callbacks,
    ["commitTs"]: groups_commitTs,
    ["componentAuthoring"]: groups_componentAuthoring,
    ["components"]: groups_components,
    ["metadata"]: groups_metadata,
    ["mounts"]: groups_mounts,
    ["nativeComponents"]: groups_nativeComponents,
    ["pagination"]: groups_pagination,
    ["reserved"]: groups_reserved,
    ["scheduling"]: groups_scheduling,
    ["storage"]: groups_storage,
    ["transactions"]: groups_transactions,
  }),
  ["metadataNode"]: metadataNode,
}) as typeof spec;

export default spec;
