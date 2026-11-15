import {
  FetchBatchSchema,
  type FetchBatch,
  type ScrapeErrorKind,
  type SearchProfile,
  type SourceAdapter,
} from "./contracts";

export type DiscoveryStatus = "success" | "partial" | "failed" | "blocked";
export type DiscoveryResult = {
  batch: FetchBatch;
  status: DiscoveryStatus;
  errorKind: ScrapeErrorKind | null;
  errorMessage: string | null;
};

export function statusForBatch(batch: FetchBatch): DiscoveryStatus {
  if (batch.errors.some((error) => ["ACCESS_DENIED", "CAPTCHA", "RATE_LIMITED", "POLICY_BLOCKED"].includes(error.kind))) return "blocked";
  if (batch.errors.length) return batch.listings.length ? "partial" : "failed";
  return batch.isFullTraversal ? "success" : "partial";
}

function applyPublishedSince(batch: FetchBatch, since: string): FetchBatch {
  const sinceTime = Date.parse(since);
  const older = batch.listings.filter((listing) =>
    listing.publishedAt !== null && Number.isFinite(Date.parse(listing.publishedAt)) && Date.parse(listing.publishedAt) < sinceTime,
  );
  if (!older.length) return { ...batch, isFullTraversal: false };
  const olderIds = new Set(older.map((listing) => listing.externalId));
  const skippedCounts = {
    ...batch.skippedCounts,
    older_than_since: (batch.skippedCounts?.older_than_since ?? 0) + older.length,
  };
  return {
    ...batch,
    listings: batch.listings.filter((listing) => !olderIds.has(listing.externalId)),
    isFullTraversal: false,
    skippedCounts,
    warnings: [...batch.warnings, `Pominięto ${older.length} ofert opublikowanych przed wskazanym --since.`],
  };
}

function errorForThrown(error: unknown, signal?: AbortSignal): ScrapeErrorKind {
  if (signal?.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) return "TIMEOUT";
  if (error instanceof Error && error.name === "ZodError") return "PARSE_CHANGED";
  if (error instanceof TypeError) return "NETWORK";
  return "INTERNAL";
}

/** Keep an unexpected adapter exception scoped to its source/profile. */
export async function discoverSafely(
  adapter: SourceAdapter,
  profile: SearchProfile,
  options: { dryRun: boolean; maxPages: number; since?: string; verbose?: boolean; signal?: AbortSignal },
): Promise<DiscoveryResult> {
  try {
    let batch = FetchBatchSchema.parse(await adapter.discover(profile, options));
    if (options.since) batch = applyPublishedSince(batch, options.since);
    const status = statusForBatch(batch);
    return {
      batch,
      status,
      errorKind: batch.errors[0]?.kind ?? null,
      errorMessage: batch.errors.length
        ? batch.errors.map((error) => error.message).join("; ").slice(0, 1000)
        : batch.warnings.length ? batch.warnings.join("; ").slice(0, 1000) : null,
    };
  } catch (error: unknown) {
    const kind = errorForThrown(error, options.signal);
    const message = kind === "TIMEOUT"
      ? "Source request was cancelled or timed out."
      : kind === "PARSE_CHANGED"
        ? "Adapter returned a batch that failed contract validation."
        : kind === "NETWORK"
          ? "Source request failed at the network boundary."
          : "Adapter execution failed; other source/profile runs will continue.";
    const batch = FetchBatchSchema.parse({
      source: adapter.source,
      profileId: profile.id,
      listings: [],
      inspectedPages: 0,
      isFullTraversal: false,
      sourceIsReachable: false,
      warnings: [],
      errors: [{ kind, message }],
    });
    return { batch, status: "failed", errorKind: kind, errorMessage: message };
  }
}
