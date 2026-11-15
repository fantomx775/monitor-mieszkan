import { describe, expect, it, vi } from "vitest";

import type { SearchProfile } from "../contracts";
import { parseAreaM2, parsePricePln, parseRoomCount } from "../normalization";
import { createDomyAdapter, parseDomyRss } from "./index";

const profile: SearchProfile = {
  id: "1f78017a-aad1-40a2-8d13-28b187ca22bf",
  key: "katowice-sale",
  label: "Katowice",
  city: "Katowice",
  preferredDistricts: [],
  preferredRooms: [],
  transaction: "sale",
  category: "apartment",
  mode: "strict",
};

const normalFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Fixture</title><item>
  <title>Mieszkanie, 2 pokoje, 45,6 m2, 449 000 zł</title>
  <link>https://www.domy.pl/mieszkanie/slaskie-katowice-2-pokoje-449000-pln-45m2-sba/dol1234567890?utm_source=feed</link>
  <description><![CDATA[Cena: 449 000 zł; Powierzchnia: 45,6 m²; 2 pokoje]]></description>
  <pubDate>Tue, 03 Nov 2026 09:10:00 +0100</pubDate>
</item></channel></rss>`;

const missingFieldsFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><item>
  <link>https://domy.pl/mieszkanie/slaskie-katowice-mieszkanie-sba/dol9876543210</link>
</item></channel></rss>`;

const changedStructureFeed = `<?xml version="1.0" encoding="UTF-8"?>
<response><offers><offer><url>https://domy.pl/example</url></offer></offers></response>`;

const skippedReasonsFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item><title>Brak linku</title></item>
  <item><link>https://example.invalid/mieszkanie/fake-sba/abc123</link></item>
  <item><link>https://domy.pl/mieszkanie/katowice-wynajem/dol1234567891</link></item>
</channel></rss>`;

describe("Domy.pl RSS adapter", () => {
  it("normalizes a confirmed sale RSS item without retaining its description or images", () => {
    const result = parseDomyRss(normalFeed, profile, "2026-11-04T07:40:00.000Z");

    expect(result.errors).toEqual([]);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      source: "domy",
      externalId: "dol1234567890",
      canonicalUrl: "https://domy.pl/mieszkanie/slaskie-katowice-2-pokoje-449000-pln-45m2-sba/dol1234567890",
      title: "Mieszkanie, 2 pokoje, 45,6 m2, 449 000 zł",
      transaction: "sale",
      category: "apartment",
      market: "unknown",
      pricePln: 449_000,
      areaM2: 45.6,
      rooms: 2,
      city: "Katowice",
      publishedAt: "2026-11-03T08:10:00.000Z",
      imageOriginalUrl: null,
      imageAlt: null,
      propertyFeatures: [],
      sourceEvidence: "rss",
      capturedAt: "2026-11-04T07:40:00.000Z",
    });
    expect(JSON.stringify(result.listings[0])).not.toContain("Cena: 449 000 zł");
  });

  it("keeps absent fields null", () => {
    const result = parseDomyRss(missingFieldsFeed, profile, "2026-11-04T07:40:00.000Z");

    expect(result.errors).toEqual([]);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      title: null,
      pricePln: null,
      areaM2: null,
      rooms: null,
      publishedAt: null,
      imageOriginalUrl: null,
    });
  });

  it("reports an unexpected feed structure instead of treating it as an empty market", () => {
    const result = parseDomyRss(changedStructureFeed, profile);

    expect(result.listings).toEqual([]);
    expect(result.errors.map(({ kind }) => kind)).toEqual(["PARSE_CHANGED"]);
  });

  it("counts skipped RSS entries by safe reason without retaining their content", () => {
    const result = parseDomyRss(skippedReasonsFeed, profile);

    expect(result.listings).toEqual([]);
    expect(result.skippedCounts).toEqual({ missing_link: 1, invalid_link: 1, not_sale_apartment: 1 });
  });

  it("does not request an unverified Tychy feed", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createDomyAdapter({ fetchImpl, minIntervalMs: 0, jitterMs: 0 });
    const result = await adapter.discover({ ...profile, city: "Tychy" }, { dryRun: true, maxPages: 1 });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.errors.map(({ kind }) => kind)).toEqual(["UNSUPPORTED"]);
    expect(result.inspectedPages).toBe(0);
  });

  it.each([
    [403, "ACCESS_DENIED"],
    [429, "RATE_LIMITED"],
  ] as const)("classifies HTTP %s without retry", async (status, expectedKind) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status }));
    const adapter = createDomyAdapter({ fetchImpl, minIntervalMs: 0, jitterMs: 0 });
    const result = await adapter.discover(profile, { dryRun: true, maxPages: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.errors.map(({ kind }) => kind)).toEqual([expectedKind]);
  });

  it("retries a transient server response once", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(normalFeed, { status: 200, headers: { "content-type": "application/rss+xml" } }));
    const adapter = createDomyAdapter({ fetchImpl, minIntervalMs: 0, jitterMs: 0 });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.requestCount).toBe(2);
    expect(result.inspectedPages).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("distinguishes CAPTCHA, timeout, and an empty confirmed RSS response", async () => {
    const captchaAdapter = createDomyAdapter({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("captcha", { status: 200, headers: { "content-type": "text/html" } }),
      ),
      minIntervalMs: 0,
      jitterMs: 0,
    });
    const captcha = await captchaAdapter.discover(profile, { dryRun: true, maxPages: 1 });
    expect(captcha.errors.map(({ kind }) => kind)).toEqual(["CAPTCHA"]);

    const timeoutFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const timeoutAdapter = createDomyAdapter({
      fetchImpl: timeoutFetch,
      timeoutMs: 5,
      minIntervalMs: 0,
      jitterMs: 0,
    });
    const timeout = await timeoutAdapter.discover(profile, { dryRun: true, maxPages: 1 });
    expect(timeout.errors.map(({ kind }) => kind)).toEqual(["TIMEOUT"]);
    expect(timeoutFetch).toHaveBeenCalledTimes(2);
    expect(timeout.inspectedPages).toBe(1);
    expect(timeout.requestCount).toBe(2);

    const emptyAdapter = createDomyAdapter({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("<rss><channel/></rss>", { status: 200, headers: { "content-type": "application/rss+xml" } }),
      ),
      minIntervalMs: 0,
      jitterMs: 0,
    });
    const empty = await emptyAdapter.discover(profile, { dryRun: true, maxPages: 1 });
    expect(empty.errors.map(({ kind }) => kind)).toEqual(["EMPTY_CONFIRMED"]);
    expect(empty.sourceIsReachable).toBe(true);
  });
});

describe("shared Polish numeric normalization", () => {
  it("parses PLN, m² and room counts with Polish separators", () => {
    expect(parsePricePln("449 000 zł")).toBe(449_000);
    expect(parsePricePln("7 290 zł/m²")).toBeNull();
    expect(parseAreaM2("45,6 m²")).toBe(45.6);
    expect(parseRoomCount("2 pokoje")).toBe(2);
  });
});
