import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SearchProfileSchema } from "../contracts";
import { AdresowoSourceAdapter } from "./adapter";
import { normalizeAdresowoSearchUrl } from "./search-url";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/current-list.html", import.meta.url)),
  "utf8",
);

const profile = SearchProfileSchema.parse({
  id: "22222222-2222-4222-8222-222222222222",
  key: "katowice",
  label: "Katowice",
  city: "Katowice",
  preferredDistricts: [],
  preferredRooms: [],
  adresowoSearchUrl: "https://adresowo.pl/mieszkania/katowice/",
  mode: "discovery",
});

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("Adresowo source adapter", () => {
  it("accepts current public result routes and the confirmed next-page route", () => {
    expect(normalizeAdresowoSearchUrl(
      "https://www.adresowo.pl/mieszkania/katowice/?utm_source=demo&fbclid=tracking",
    )).toBe("https://adresowo.pl/mieszkania/katowice/");
    expect(normalizeAdresowoSearchUrl(
      "https://adresowo.pl/mieszkania/katowice/_l2",
    )).toBe("https://adresowo.pl/mieszkania/katowice/_l2");
    expect(normalizeAdresowoSearchUrl(
      "https://adresowo.pl/f/mieszkania/katowice/",
    )).toBe("https://adresowo.pl/f/mieszkania/katowice/");
    expect(() => normalizeAdresowoSearchUrl("https://example.com/mieszkania/katowice/")).toThrow();
  });

  it("parses current card text fields without reading script challenge markers", async () => {
    const requested: string[] = [];
    const adapter = new AdresowoSourceAdapter({
      fetchImpl: async (...args) => {
        requested.push(String(args[0]));
        return htmlResponse(fixture);
      },
      minHostIntervalMs: 0,
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 1 });

    expect(requested).toEqual(["https://adresowo.pl/mieszkania/katowice/"]);
    expect(result).toMatchObject({
      source: "adresowo",
      listings: [
        { externalId: "fixture-1", pricePln: 499000, areaM2: 42.5, rooms: 2 },
        { externalId: "fixture-2", pricePln: null, areaM2: 31.2, rooms: 1 },
        { externalId: "fixture-3", pricePln: 875000, areaM2: 82, rooms: 3 },
      ],
      inspectedPages: 1,
      requestCount: 1,
      sourceIsReachable: true,
      errors: [],
    });
    expect(result.warnings).toContain("1 ofert nie zawierało ceny, metrażu lub liczby pokoi.");
  });

  it("follows only the confirmed next link and respects the page budget", async () => {
    const requested: string[] = [];
    const secondPage = fixture.replaceAll("fixture-1", "fixture-4");
    const adapter = new AdresowoSourceAdapter({
      fetchImpl: async (...args) => {
        const url = String(args[0]);
        requested.push(url);
        return htmlResponse(url.endsWith("/_l2") ? secondPage : fixture);
      },
      minHostIntervalMs: 0,
    });

    const firstPageOnly = await adapter.discover(profile, { dryRun: true, maxPages: 1 });
    expect(firstPageOnly.inspectedPages).toBe(1);
    expect(firstPageOnly.requestCount).toBe(1);
    expect(firstPageOnly.warnings).toContain("Osiągnięto limit 1 stron; pozostał jawny link do kolejnej strony.");
    expect(requested).toEqual(["https://adresowo.pl/mieszkania/katowice/"]);

    requested.length = 0;
    const twoPages = await adapter.discover(profile, { dryRun: true, maxPages: 2 });
    expect(twoPages.inspectedPages).toBe(2);
    expect(twoPages.requestCount).toBe(2);
    expect(requested).toEqual([
      "https://adresowo.pl/mieszkania/katowice/",
      "https://adresowo.pl/mieszkania/katowice/_l2",
    ]);
    expect(new Set(twoPages.listings.map((listing) => listing.externalId)).size).toBe(4);
  });

  it("finds the sequential same-origin page link when its label is numeric", async () => {
    const requested: string[] = [];
    const pageWithNumericPager = fixture.replace(
      '<nav aria-label="Paginacja">\n        <a href="/mieszkania/katowice/_l2">Następna strona</a>\n      </nav>',
      '<a href="https://www.adresowo.pl/mieszkania/katowice/_l2">Następna strona</a>\n'
        + '<nav aria-label="Paginacja"><a href="/mieszkania/katowice/_l2">2</a></nav>',
    );
    const adapter = new AdresowoSourceAdapter({
      fetchImpl: async (...args) => {
        const url = String(args[0]);
        requested.push(url);
        return htmlResponse(url.endsWith("/_l2") ? fixture.replaceAll("fixture-1", "fixture-4") : pageWithNumericPager);
      },
      minHostIntervalMs: 0,
    });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 2 });

    expect(requested).toEqual([
      "https://adresowo.pl/mieszkania/katowice/",
      "https://adresowo.pl/mieszkania/katowice/_l2",
    ]);
    expect(result.inspectedPages).toBe(2);
    expect(result.requestCount).toBe(2);
  });

  it("does not follow a next link across origins", async () => {
    const requested: string[] = [];
    const unrelatedPager = fixture.replace(
      '<a href="/mieszkania/katowice/_l2">Następna strona</a>',
      '<a href="https://www.adresowo.pl/mieszkania/katowice/_l2">Następna strona</a>',
    );
    const adapter = new AdresowoSourceAdapter({
      fetchImpl: async (...args) => {
        requested.push(String(args[0]));
        return htmlResponse(unrelatedPager);
      },
      minHostIntervalMs: 0,
    });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 2 });

    expect(requested).toEqual(["https://adresowo.pl/mieszkania/katowice/"]);
    expect(result.inspectedPages).toBe(1);
    expect(result.requestCount).toBe(1);
    expect(result.warnings).not.toContain("Osiągnięto limit 2 stron; pozostał jawny link do kolejnej strony.");
  });

  it("stops when a CAPTCHA is visible in the page body", async () => {
    let requestCount = 0;
    const adapter = new AdresowoSourceAdapter({
      fetchImpl: async () => {
        requestCount += 1;
        return htmlResponse("<html><body><h1>CAPTCHA: verify you are human</h1></body></html>");
      },
      minHostIntervalMs: 0,
    });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 5 });

    expect(requestCount).toBe(1);
    expect(result.errors[0]?.kind).toBe("CAPTCHA");
    expect(result.inspectedPages).toBe(1);
  });
});
