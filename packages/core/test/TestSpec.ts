import { GroupSpec, Spec } from "@confect/core";
import type * as Record from "effect/Record";

type Named<Groups extends Record.ReadonlyRecord<string, GroupSpec.Any>> = {
  readonly [Name in keyof Groups & string]: GroupSpec.NamedAt<
    Groups[Name],
    Name
  >;
};

// Types a hand-assembled spec the way generated `spec.ts` annotates it.
export const fromGroups = <
  const Groups extends Record.ReadonlyRecord<string, GroupSpec.AnyWithProps>,
>(
  groups: Groups,
) => Spec.fromGroups(groups) as Spec.Spec<Named<Groups>>;

export const addGroupsAt = <
  Group extends GroupSpec.AnyWithProps,
  const Children extends Record.ReadonlyRecord<string, GroupSpec.AnyWithProps>,
>(
  group: Group,
  children: Children,
) =>
  GroupSpec.addGroupsAt(group, children) as GroupSpec.AddGroups<
    Group,
    Named<Children>[keyof Children & string]
  >;
