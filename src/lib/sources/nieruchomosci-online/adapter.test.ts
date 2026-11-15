import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchProfileSchema } from "../contracts";
import { createNieruchomosciOnlineAdapter } from "./adapter";

const profile = SearchProfileSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  key: "katowice",
  label: "Katowice",
  city: "Katowice",
  preferredDistricts: [],
  preferredRooms: [],
  mode: "discovery",
});

afterEach(() => {
  vi.restoreAllMocks();
});

let rateLimitClock = Date.now() + 1_000_000_000;

function listing(
  id: string,
  title: string,
  price: string,
  area: string,
  roomText = "",
): string {
  return `<article data-id="${id}">
    <a href="/mieszkanie/katowice/${id}" title="${title}">${title}</a>
    <span class="none">${price}</span>
    <span class="area">${area}</span>
    <span class="rooms">${roomText}</span>
  </article>`;
}

function page(cards: string, pageNumbers: number[]): string {
  const navigation = pageNumbers
    .map((number) => `<a href="/mieszkania,sprzedaz/?p=${number}">${number}</a>`)
    .join("");
  return `<!doctype html><html><body>${cards}<nav>${navigation}</nav></body></html>`;
}

function adapterFor(pages: Map<number, string>) {
  const requestedPages: number[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const pageNumber = Number(url.searchParams.get("p") ?? 1);
    requestedPages.push(pageNumber);
    return new Response(pages.get(pageNumber) ?? "", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  return {
    adapter: createNieruchomosciOnlineAdapter({
      fetchImpl,
      now: () => new Date("2026-11-08T12:00:00.000Z"),
    }),
    requestedPages,
  };
}

function makeRateLimitClockAdvanceWithoutWaiting(): void {
  vi.spyOn(Date, "now").mockImplementation(() => {
    rateLimitClock += 60_000;
    return rateLimitClock;
  });
}

describe("Nieruchomosci-online source adapter", () => {
  it("paginates only within maxPages, deduplicates ids, and keeps missing fields nullable", async () => {
    makeRateLimitClockAdvanceWithoutWaiting();
    const page1 = page([
      listing("offer-1", "Mieszkanie dwupokojowe", "750 000 zł", "54,5 m²", "2-pokojowe"),
      listing("offer-2", "Mieszkanie na sprzedaż", "Cena do uzgodnienia", "43 m²"),
    ].join(""), [2]);
    const page2 = page([
      listing("offer-2", "Mieszkanie na sprzedaż", "Cena do uzgodnienia", "43 m²"),
      listing("offer-3", "Mieszkanie trzypokojowe", "620 000 zł", "58 m²", "3 pokoje"),
    ].join(""), [1, 2, 3]);
    const { adapter, requestedPages } = adapterFor(new Map([[1, page1], [2, page2]]));

    const batch = await adapter.discover(profile, { dryRun: true, maxPages: 2 });
    const missingPrice = batch.listings.find((item) => item.externalId === "offer-2");

    expect(requestedPages).toEqual([1, 2]);
    expect(batch).toMatchObject({
      source: "nieruchomosci_online",
      requestCount: 2,
      inspectedPages: 2,
      isFullTraversal: false,
      sourceIsReachable: true,
    });
    expect(batch.listings).toHaveLength(3);
    expect(new Set(batch.listings.map((item) => item.externalId)).size).toBe(3);
    expect(batch.listings.filter((item) => item.pricePln !== null)).toHaveLength(2);
    expect(batch.listings.filter((item) => item.areaM2 !== null)).toHaveLength(3);
    expect(batch.listings.filter((item) => item.rooms !== null)).toHaveLength(2);
    expect(missingPrice).toMatchObject({ pricePln: null, areaM2: 43, rooms: null });
    expect(batch.warnings.join(" ")).toContain("Na stronie 2 pominięto powtórzone rekordy: 1");
    expect(batch.warnings.join(" ")).toContain("cena: 1/3");
    expect(batch.warnings.join(" ")).toContain("liczba pokoi: 1/3");
    expect(batch.warnings.join(" ")).toContain("limit stron (2)");
    expect(await adapter.healthcheck()).toMatchObject({ status: "LIVE_PARTIAL" });
  });

  it("stops on an explicitly empty later page and reports incomplete coverage", async () => {
    makeRateLimitClockAdvanceWithoutWaiting();
    const page1 = page(listing("offer-1", "Mieszkanie dwupokojowe", "750 000 zł", "54,5 m²", "2 pokoje"), [2]);
    const emptyPage = "<!doctype html><html><body><p>Nie znaleźliśmy żadnych ofert</p></body></html>";
    const { adapter, requestedPages } = adapterFor(new Map([[1, page1], [2, emptyPage]]));

    const batch = await adapter.discover(profile, { dryRun: true, maxPages: 4 });

    expect(requestedPages).toEqual([1, 2]);
    expect(batch.listings).toHaveLength(1);
    expect(batch.errors.map((error) => error.kind)).toEqual(["EMPTY_CONFIRMED"]);
    expect(batch.isFullTraversal).toBe(false);
    expect(batch.warnings.join(" ")).toContain("Strona 2 nie zawierała ofert");
  });

  it("stops when a later page contains only duplicate listing ids", async () => {
    makeRateLimitClockAdvanceWithoutWaiting();
    const repeatedListing = listing("offer-1", "Mieszkanie dwupokojowe", "750 000 zł", "54,5 m²", "2 pokoje");
    const page1 = page(repeatedListing, [2]);
    const duplicatePage = page(repeatedListing, [1, 2, 3]);
    const { adapter, requestedPages } = adapterFor(new Map([[1, page1], [2, duplicatePage]]));

    const batch = await adapter.discover(profile, { dryRun: true, maxPages: 5 });

    expect(requestedPages).toEqual([1, 2]);
    expect(batch.listings).toHaveLength(1);
    expect(batch.isFullTraversal).toBe(false);
    expect(batch.warnings.join(" ")).toContain("Strona 2 nie zawierała nowych ofert; powtórzone rekordy: 1");
  });
});
