import { AuthFamily } from "@confect/core";
import * as Arr from "effect/Array";
import { providers } from "./_generated/auth.providers";

/**
 * The service family's peer names as the generated list reads them now. The
 * query and both Node actions import this module, so Convex's Node bundle puts
 * it and the generated list in a chunk the actions share.
 */
export const peers = () =>
  Arr.flatMap(providers(), (provider) =>
    provider.family === "service" && provider.name !== undefined
      ? [provider.name]
      : [],
  );

/**
 * The provider a verified issuer belongs to, as a route guard matches it: the
 * peer's name, the family of a provider with no name, or the lookup's tag.
 */
export const match = (issuer: string): string => {
  const found = AuthFamily.lookup(providers(), issuer);
  return found._tag === "Provider"
    ? (found.provider.name ?? found.provider.family ?? "Provider")
    : found._tag;
};
