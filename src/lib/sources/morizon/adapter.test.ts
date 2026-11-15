import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { SearchProfileSchema } from "../contracts";
import {
  MorizonSourceAdapter,
  morizonHttpErrorKind,
  morizonSearchUrl,
  parseMorizonSearchPage,
} from "./adapter";

const profile = SearchProfileSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  key: "katowice",
  label: "Katowice",
  city: "Katowice",
  preferredDistricts: [],
  preferredRooms: [],
  mode: "discovery",
});

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

describe("Morizon source adapter", () => {
  it("builds the public sale apartment results URL from the profile city", () => {
    expect(morizonSearchUrl("Kraków")).toBe("https://www.morizon.pl/mieszkania/krakow/");
  });

  it("normalizes only the verified card fields and keeps the title and media empty", () => {
    const result = parseMorizonSearchPage(fixture("search-normal.html"), profile, "2026-11-04T12:00:00.000Z");

    expect(result.kind).toBe("listings");
    if (result.kind !== "listings") return;
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      source: "morizon",
      externalId: "mzn1000000001",
      canonicalUrl: "https://morizon.pl/oferta/sprzedaz-mieszkanie-katowice-przykladowa-ulica-48m2-mzn1000000001",
      title: null,
      transaction: "sale",
      category: "apartment",
      market: "unknown",
      pricePln: 399000,
      areaM2: 48,
      rooms: 3,
      city: "Katowice",
      district: null,
      imageOriginalUrl: null,
      propertyFeatures: [],
    });
  });

  it("keeps unavailable card attributes null instead of guessing", () => {
    const result = parseMorizonSearchPage(fixture("search-missing-fields.html"), profile, "2026-11-04T12:00:00.000Z");

    expect(result.kind).toBe("listings");
    if (result.kind !== "listings") return;
    expect(result.listings[0]).toMatchObject({ pricePln: null, areaM2: null, rooms: null });
  });

  it("classifies an unrecognized results layout as a parse change", () => {
    expect(parseMorizonSearchPage(fixture("search-changed.html"), profile, "2026-11-04T12:00:00.000Z")).toEqual({
      kind: "changed",
    });
  });

  it("distinguishes access denial, throttling, and server/network errors", () => {
    expect(morizonHttpErrorKind(403)).toBe("ACCESS_DENIED");
    expect(morizonHttpErrorKind(429)).toBe("RATE_LIMITED");
    expect(morizonHttpErrorKind(408)).toBe("TIMEOUT");
    expect(morizonHttpErrorKind(503)).toBe("NETWORK");
    expect(morizonHttpErrorKind(200)).toBeNull();
  });

  it("stops on an access-denied response without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const adapter = new MorizonSourceAdapter({ fetchImpl, minHostIntervalMs: 0, hostJitterMs: 0 });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.errors[0]?.kind).toBe("ACCESS_DENIED");
    expect(result.requestCount).toBe(1);
    expect(result.sourceIsReachable).toBe(true);
    await expect(adapter.healthcheck()).resolves.toMatchObject({ status: "BLOCKED_BY_ACCESS_OR_POLICY" });
  });

  it("classifies an HTTP 200 challenge page as CAPTCHA", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<html><body>Sprawdź, czy jesteś człowiekiem</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const adapter = new MorizonSourceAdapter({ fetchImpl, minHostIntervalMs: 0, hostJitterMs: 0 });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 1 });

    expect(result.errors[0]?.kind).toBe("CAPTCHA");
    expect(result.requestCount).toBe(1);
    expect(result.sourceIsReachable).toBe(true);
    await expect(adapter.healthcheck()).resolves.toMatchObject({ status: "BLOCKED_BY_ACCESS_OR_POLICY" });
  });

  it("classifies an aborted page request as a timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const adapter = new MorizonSourceAdapter({ fetchImpl, requestTimeoutMs: 10, minHostIntervalMs: 0, hostJitterMs: 0 });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 1 });

    expect(result.errors[0]?.kind).toBe("TIMEOUT");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.inspectedPages).toBe(1);
    expect(result.requestCount).toBe(2);
    expect(await adapter.healthcheck()).toMatchObject({ status: "FAILED" });
  });

  it("does not fetch more than the first page even when a larger budget is requested", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(fixture("search-normal.html"), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const adapter = new MorizonSourceAdapter({ fetchImpl, now: () => new Date("2026-11-04T12:00:00.000Z"), minHostIntervalMs: 0, hostJitterMs: 0 });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 5 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.morizon.pl/mieszkania/katowice/",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(result.inspectedPages).toBe(1);
    expect(result.isFullTraversal).toBe(false);
    expect(result.listings).toHaveLength(1);
    await expect(adapter.healthcheck()).resolves.toMatchObject({ status: "LIVE_PARTIAL" });
  });

  it("retries one HTTP 503 and records the number of requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(fixture("search-normal.html"), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
    const adapter = new MorizonSourceAdapter({ fetchImpl, now: () => new Date("2026-11-04T12:00:00.000Z"), minHostIntervalMs: 0, hostJitterMs: 0 });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.requestCount).toBe(2);
    expect(result.inspectedPages).toBe(1);
    expect(result.listings).toHaveLength(1);
  });

  it("records Retry-After and does not repeat a throttled request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 429, headers: { "retry-after": "120" } }),
    );
    const adapter = new MorizonSourceAdapter({ fetchImpl, minHostIntervalMs: 0, hostJitterMs: 0 });

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.errors[0]?.kind).toBe("RATE_LIMITED");
    expect(result.errors[0]?.message).toContain("Retry-After: 120");
  });
});
