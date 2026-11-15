import { describe, expect, it, vi } from "vitest";
import { SearchProfileSchema, type NormalizedListing, type SearchProfile, type SourceAdapter, type SourceKey } from "./contracts";
import { discoverSafely } from "./discovery";

const profile = SearchProfileSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  key: "katowice",
  label: "Katowice",
  city: "Katowice",
  preferredDistricts: [],
  preferredRooms: [],
  mode: "discovery",
});

function adapter(source: SourceKey, discover: SourceAdapter["discover"]): SourceAdapter {
  return {
    source,
    discover,
    async healthcheck() { return { status: "NOT_TESTED" }; },
  };
}

function listing(externalId: string, publishedAt: string | null): NormalizedListing {
  return {
    source: "domy",
    externalId,
    canonicalUrl: `https://domy.pl/mieszkanie/${externalId}-sba`,
    title: null,
    transaction: "sale",
    category: "apartment",
    market: "unknown",
    pricePln: null,
    areaM2: null,
    rooms: null,
    floor: null,
    city: "Katowice",
    district: null,
    street: null,
    latitude: null,
    longitude: null,
    publishedAt,
    promotedAt: null,
    imageOriginalUrl: null,
    imageAlt: null,
    propertyFeatures: [],
    sourceEvidence: "rss",
    capturedAt: "2026-11-04T00:00:00.000Z",
  };
}

describe("discoverSafely", () => {
  it("records an unexpected source failure and continues with the next source", async () => {
    const failing = adapter("morizon", vi.fn(async () => { throw new Error("private response detail"); }));
    const succeeding = adapter("domy", vi.fn(async (requestedProfile: SearchProfile) => ({
      source: "domy" as const,
      profileId: requestedProfile.id,
      listings: [],
      inspectedPages: 1,
      isFullTraversal: true,
      sourceIsReachable: true,
      warnings: [],
      errors: [],
    })));

    const results = [];
    for (const source of [failing, succeeding]) {
      results.push(await discoverSafely(source, profile, { dryRun: true, maxPages: 1 }));
    }

    expect(results.map((result) => result.status)).toEqual(["failed", "success"]);
    expect(results[0].batch.errors[0]?.kind).toBe("INTERNAL");
    expect(results[0].errorMessage).not.toContain("private response detail");
    expect(succeeding.discover).toHaveBeenCalledOnce();
  });

  it("keeps policy failures distinct from parser and network failures", async () => {
    const blocked = adapter("olx", vi.fn(async (requestedProfile: SearchProfile) => ({
      source: "olx" as const,
      profileId: requestedProfile.id,
      listings: [],
      inspectedPages: 0,
      isFullTraversal: false,
      sourceIsReachable: false,
      warnings: [],
      errors: [{ kind: "POLICY_BLOCKED" as const, message: "Not permitted." }],
    })));

    const result = await discoverSafely(blocked, profile, { dryRun: false, maxPages: 1 });

    expect(result.status).toBe("blocked");
    expect(result.errorKind).toBe("POLICY_BLOCKED");
  });

  it("applies --since only to known portal publication dates and marks traversal partial", async () => {
    const source = adapter("domy", vi.fn(async (requestedProfile: SearchProfile) => ({
      source: "domy" as const,
      profileId: requestedProfile.id,
      listings: [
        listing("old", "2026-10-01T00:00:00.000Z"),
        listing("new", "2026-11-02T00:00:00.000Z"),
        listing("unknown", null),
      ],
      inspectedPages: 1,
      isFullTraversal: true,
      sourceIsReachable: true,
      warnings: [],
      errors: [],
    })));

    const result = await discoverSafely(source, profile, {
      dryRun: true,
      maxPages: 1,
      since: "2026-11-01T00:00:00.000Z",
    });

    expect(result.batch.listings.map((item) => item.externalId)).toEqual(["new", "unknown"]);
    expect(result.batch.skippedCounts).toEqual({ older_than_since: 1 });
    expect(result.batch.isFullTraversal).toBe(false);
    expect(result.status).toBe("partial");
  });
});
