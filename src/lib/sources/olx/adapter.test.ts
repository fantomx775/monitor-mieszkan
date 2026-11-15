import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { SearchProfileSchema } from "../contracts";
import { OLX_POLICY_SOURCES, OlxSourceAdapter } from "./adapter";

const profile = SearchProfileSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  key: "katowice",
  label: "Katowice",
  city: "Katowice",
  preferredDistricts: [],
  preferredRooms: [],
  mode: "discovery",
  olxSearchUrl: "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/katowice/",
  olxSearchParams: { categoryId: 14, regionId: 6, cityId: 7691 },
});

function policyFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/policy-findings.json", import.meta.url)), "utf8")) as Record<string, unknown>;
}

function listing(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Mieszkanie testowe ${id}`,
    url: `https://www.olx.pl/d/oferta/mieszkanie-testowe-CID3-ID${id}.html`,
    created_time: "2026-11-01T12:00:00Z",
    location: { city: { name: "Katowice" }, district: { name: "Śródmieście" } },
    params: [
      { key: "price", value: { value: "500000", currency: "PLN", arranged: false, budget: false } },
      { key: "m", value: { label: "55 m²" } },
      { key: "rooms", value: { label: "2 pokoje" } },
      { key: "floor_select", value: { label: "3" } },
    ],
    ...overrides,
  };
}

function graphqlResponse(records: unknown[], totalElements: number, nextOffset: number | null): Response {
  return new Response(JSON.stringify({
    data: {
      clientCompatibleListings: {
        __typename: "ListingSuccess",
        data: records,
        metadata: { total_elements: totalElements },
        links: {
          next: nextOffset === null
            ? null
            : { href: `https://www.olx.pl/api/v1/offers?offset=${nextOffset}&limit=40&query=&category_id=14&region_id=6&city_id=7691&suggest_filters=true` },
        },
      },
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("OLX source adapter", () => {
  it("keeps the current policy and public-query evidence explicit", () => {
    expect(policyFixture()).toMatchObject({
      verifiedAt: "2026-11-08",
      officialSources: OLX_POLICY_SOURCES,
      partnerApiCanReadOtherUsersOffers: false,
      partnerApiAdvertListUsesOwnerContext: true,
      robotsDisallowsApiByDefault: true,
      robotsDisallowsGraphqlPath: false,
      latestServiceTermsFullyReviewed: false,
      automationPermissionForPublicOffersConfirmed: false,
      decision: "LIVE_PARTIAL_TECHNICAL_PROBE",
      graphqlProbe: {
        statusCodes: [200, 200, 200],
        offsets: [0, 40, 39],
        recordsReturned: [51, 45, 48],
        reportedTotal: 966,
        challengesObserved: false,
      },
    });
    expect(policyFixture().robotsApiExceptions).toEqual([
      "/api/v1/offers/",
      "/api/v1/targeting/",
      "/api/v1/friendly-links/",
    ]);
  });

  it("follows the server next offset and counts missing fields and a bounded partial import", async () => {
    const offsets: number[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        variables: { searchParameters: Array<{ key: string; value: string }> };
      };
      const offset = Number(body.variables.searchParameters.find((parameter) => parameter.key === "offset")?.value);
      offsets.push(offset);

      if (offset === 0) {
        return graphqlResponse([
          listing(1001),
          listing(1002, {
            created_time: null,
            location: { city: null, district: null },
            params: [],
          }),
        ], 966, 39);
      }
      return graphqlResponse([listing(1003)], 966, 79);
    });
    const adapter = new OlxSourceAdapter({
      fetchImpl: fetchImpl as typeof fetch,
      minHostIntervalMs: 0,
      now: () => new Date("2026-11-08T10:00:00.000Z"),
    });

    const result = await adapter.discover(profile, { dryRun: false, maxPages: 2 });

    expect(offsets).toEqual([0, 39]);
    expect(result).toMatchObject({
      source: "olx",
      profileId: profile.id,
      inspectedPages: 2,
      requestCount: 2,
      isFullTraversal: false,
      sourceIsReachable: true,
      errors: [],
      skippedCounts: {
        missing_price_pln: 1,
        missing_area_m2: 1,
        missing_rooms: 1,
        missing_floor: 1,
        missing_city: 1,
        missing_district: 1,
        missing_published_at: 1,
      },
    });
    expect(result.listings).toHaveLength(3);
    expect(result.warnings.join(" ")).toContain("Import jest niepełny");
    expect(result.warnings.join(" ")).toContain("price_pln=1");
    expect(await adapter.healthcheck()).toMatchObject({ status: "LIVE_PARTIAL" });
  });

  it.each([
    { name: "access denial", status: 403, body: "blocked", kind: "ACCESS_DENIED" },
    { name: "rate limiting", status: 429, body: "rate limited", kind: "RATE_LIMITED" },
    { name: "CAPTCHA challenge", status: 200, body: JSON.stringify({ message: "captcha required" }), kind: "CAPTCHA" },
  ])("stops on $name without retrying", async ({ status, body, kind }) => {
    const fetchImpl = vi.fn(async () => new Response(body, {
      status,
      headers: { "content-type": status === 200 ? "application/json" : "text/plain" },
    }));
    const adapter = new OlxSourceAdapter({ fetchImpl: fetchImpl as typeof fetch, minHostIntervalMs: 0 });

    const result = await adapter.discover(profile, { dryRun: false, maxPages: 5 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      listings: [],
      inspectedPages: 0,
      requestCount: 1,
      isFullTraversal: false,
      errors: [{ kind }],
    });
    expect(await adapter.healthcheck()).toMatchObject({ status: "BLOCKED_BY_ACCESS_OR_POLICY" });
  });
});
