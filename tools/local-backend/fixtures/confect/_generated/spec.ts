import { GroupSpec, Spec } from "@confect/core";
import clients from "../clients.spec.js";
import groups_authentication from "../groups/authentication.spec.js";
import groups_cacheControl from "../groups/cacheControl.spec.js";
import groups_cacheStubbed from "../groups/cacheStubbed.spec.js";
import groups_callbacks from "../groups/callbacks.spec.js";
import groups_commitTs from "../groups/commitTs.spec.js";
import groups_componentAuthoring from "../groups/componentAuthoring.spec.js";
import groups_componentIdentity from "../groups/componentIdentity.spec.js";
import groups_components from "../groups/components.spec.js";
import groups_contextReuse from "../groups/contextReuse.spec.js";
import groups_documentIds from "../groups/documentIds.spec.js";
import groups_ioBans from "../groups/ioBans.spec.js";
import groups_metadata from "../groups/metadata.spec.js";
import groups_mounts from "../groups/mounts.spec.js";
import groups_nativeComponents from "../groups/nativeComponents.spec.js";
import groups_pagination from "../groups/pagination.spec.js";
import groups_randomness from "../groups/randomness.spec.js";
import groups_requests from "../groups/requests.spec.js";
import groups_reserved from "../groups/reserved.spec.js";
import groups_scheduling from "../groups/scheduling.spec.js";
import groups_storage from "../groups/storage.spec.js";
import groups_transactions from "../groups/transactions.spec.js";
import ioBansNode from "../ioBansNode.spec.js";
import metadataNode from "../metadataNode.spec.js";

const spec: Spec.Spec<{
  readonly clients: GroupSpec.NamedAt<typeof clients, "clients">;
  readonly groups: GroupSpec.NamedAt<GroupSpec.GroupSpec<"Convex", "groups", never, GroupSpec.NamedAt<typeof groups_authentication, "authentication"> | GroupSpec.NamedAt<typeof groups_cacheControl, "cacheControl"> | GroupSpec.NamedAt<typeof groups_cacheStubbed, "cacheStubbed"> | GroupSpec.NamedAt<typeof groups_callbacks, "callbacks"> | GroupSpec.NamedAt<typeof groups_commitTs, "commitTs"> | GroupSpec.NamedAt<typeof groups_componentAuthoring, "componentAuthoring"> | GroupSpec.NamedAt<typeof groups_componentIdentity, "componentIdentity"> | GroupSpec.NamedAt<typeof groups_components, "components"> | GroupSpec.NamedAt<typeof groups_contextReuse, "contextReuse"> | GroupSpec.NamedAt<typeof groups_documentIds, "documentIds"> | GroupSpec.NamedAt<typeof groups_ioBans, "ioBans"> | GroupSpec.NamedAt<typeof groups_metadata, "metadata"> | GroupSpec.NamedAt<typeof groups_mounts, "mounts"> | GroupSpec.NamedAt<typeof groups_nativeComponents, "nativeComponents"> | GroupSpec.NamedAt<typeof groups_pagination, "pagination"> | GroupSpec.NamedAt<typeof groups_randomness, "randomness"> | GroupSpec.NamedAt<typeof groups_requests, "requests"> | GroupSpec.NamedAt<typeof groups_reserved, "reserved"> | GroupSpec.NamedAt<typeof groups_scheduling, "scheduling"> | GroupSpec.NamedAt<typeof groups_storage, "storage"> | GroupSpec.NamedAt<typeof groups_transactions, "transactions">>, "groups">;
  readonly ioBansNode: GroupSpec.NamedAt<typeof ioBansNode, "ioBansNode">;
  readonly metadataNode: GroupSpec.NamedAt<typeof metadataNode, "metadataNode">;
}> = Spec.fromGroups({
  ["clients"]: clients,
  ["groups"]: GroupSpec.addGroupsAt(GroupSpec.make(), {
    ["authentication"]: groups_authentication,
    ["cacheControl"]: groups_cacheControl,
    ["cacheStubbed"]: groups_cacheStubbed,
    ["callbacks"]: groups_callbacks,
    ["commitTs"]: groups_commitTs,
    ["componentAuthoring"]: groups_componentAuthoring,
    ["componentIdentity"]: groups_componentIdentity,
    ["components"]: groups_components,
    ["contextReuse"]: groups_contextReuse,
    ["documentIds"]: groups_documentIds,
    ["ioBans"]: groups_ioBans,
    ["metadata"]: groups_metadata,
    ["mounts"]: groups_mounts,
    ["nativeComponents"]: groups_nativeComponents,
    ["pagination"]: groups_pagination,
    ["randomness"]: groups_randomness,
    ["requests"]: groups_requests,
    ["reserved"]: groups_reserved,
    ["scheduling"]: groups_scheduling,
    ["storage"]: groups_storage,
    ["transactions"]: groups_transactions,
  }),
  ["ioBansNode"]: ioBansNode,
  ["metadataNode"]: metadataNode,
}) as typeof spec;

export default spec;
