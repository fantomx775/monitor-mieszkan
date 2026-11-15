import type { FetchBatch, SearchProfile, SourceAdapter, SourceKey } from "./contracts";

type AutomatedSourceKey = Exclude<SourceKey, "manual">;

/** Create an adapter that records an explicit policy block without contacting a portal. */
export function createPolicyBlockedAdapter(
  source: AutomatedSourceKey,
  diagnostic: string,
): SourceAdapter {
  return {
    source,
    async discover(profile: SearchProfile): Promise<FetchBatch> {
      return {
        source,
        profileId: profile.id,
        listings: [],
        inspectedPages: 0,
        isFullTraversal: false,
        sourceIsReachable: false,
        warnings: [diagnostic],
        errors: [{ kind: "POLICY_BLOCKED", message: diagnostic }],
      };
    },
    async healthcheck() {
      return { status: "BLOCKED_BY_ACCESS_OR_POLICY", diagnostic };
    },
  };
}
