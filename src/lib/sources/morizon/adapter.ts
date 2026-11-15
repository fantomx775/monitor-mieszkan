import { load, type CheerioAPI, type Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";

import {
  FetchBatchSchema,
  NormalizedListingSchema,
  type FetchBatch,
  type NormalizedListing,
  type SearchProfile,
  type SourceAccessStatus,
  type SourceAdapter,
} from "../contracts";
import {
  canonicalizeListingUrl,
  parseAreaM2,
  parsePricePln,
  parseRoomCount,
  stableExternalId,
} from "../normalization";
import { retryTransient } from "../retry";

const SOURCE_URL = "https://www.morizon.pl";
const MAX_PAGES_PER_PROFILE = 1;
const REQUEST_TIMEOUT_MS = 12_000;
const MIN_HOST_INTERVAL_MS = 2_500;
const HOST_JITTER_MS = 500;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

type ScrapeErrorKind = FetchBatch["errors"][number]["kind"];
type PageParseResult =
  | { kind: "listings"; listings: NormalizedListing[] }
  | { kind: "empty" }
  | { kind: "changed" };

export type MorizonAdapterOptions = {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  minHostIntervalMs?: number;
  hostJitterMs?: number;
  now?: () => Date;
};

class MorizonRequestError extends Error {
  constructor(readonly kind: "TIMEOUT" | "NETWORK", readonly retryable = false) {
    super(kind === "TIMEOUT" ? "Morizon request timed out" : "Morizon request failed");
    this.name = "MorizonRequestError";
  }
}

let hostRequestQueue: Promise<void> = Promise.resolve();
let lastHostRequestAt = 0;

function abortedError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withMorizonHostRateLimit<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
  minIntervalMs = MIN_HOST_INTERVAL_MS,
  jitterMs = HOST_JITTER_MS,
): Promise<T> {
  const queued = hostRequestQueue.then(async () => {
    if (signal?.aborted) throw abortedError();
    const scheduledAt = lastHostRequestAt + minIntervalMs + Math.floor(Math.random() * jitterMs);
    const waitMs = scheduledAt - Date.now();
    if (waitMs > 0) await delay(waitMs, signal);
    if (signal?.aborted) throw abortedError();
    lastHostRequestAt = Date.now();
    return operation();
  });

  hostRequestQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function withRequestTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeoutElapsed = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => {
    timeoutElapsed = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (error instanceof MorizonRequestError) throw error;
    const kind = timeoutElapsed || signal?.aborted ? "TIMEOUT" : "NETWORK";
    const retryable = !signal?.aborted && (timeoutElapsed || error instanceof TypeError || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)));
    throw new MorizonRequestError(kind, retryable);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readHtml(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let byteCount = 0;
  let html = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > maxBytes) {
      await reader.cancel();
      throw new Error("Response exceeded the HTML size limit");
    }
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

function citySlug(city: string): string {
  const slug = city
    .trim()
    .replace(/[łŁ]/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Profil Morizon wymaga poprawnej nazwy miasta");
  return slug;
}

export function morizonSearchUrl(city: string): string {
  return `${SOURCE_URL}/mieszkania/${citySlug(city)}/`;
}

function hasCaptchaChallenge(content: string): boolean {
  const normalized = content.toLocaleLowerCase("pl-PL").replace(/\s+/g, " ");
  return [
    "captcha",
    "verify you are human",
    "robot check",
    "potwierdź, że nie jesteś robotem",
    "sprawdź, czy jesteś człowiekiem",
    "wykryliśmy nietypowy ruch",
  ].some((marker) => normalized.includes(marker));
}

export function morizonHttpErrorKind(status: number): ScrapeErrorKind | null {
  if (status === 401 || status === 403) return "ACCESS_DENIED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status >= 500) return "NETWORK";
  if (status >= 400) return "NETWORK";
  return null;
}

function visibleText($: CheerioAPI): string {
  const text = $("body").text() || $.root().text();
  return text.replace(/\s+/g, " ").trim();
}

function confirmsEmptySearch(text: string): boolean {
  const normalized = text.toLocaleLowerCase("pl-PL");
  return [
    "nie znaleźliśmy żadnych ofert",
    "nie znaleziono ofert",
    "nie znaleźliśmy wyników",
    "nie znaleziono wyników",
    "brak ofert spełniających kryteria",
  ].some((marker) => normalized.includes(marker));
}

function listingIdFromHref(href: string): string | null {
  return href.match(/mzn\d+/i)?.[0] ?? null;
}

function isSaleApartmentPath(pathname: string): boolean {
  return /\/oferta\/sprzedaz-mieszkanie(?:s)?(?:[-/]|$)/i.test(pathname);
}

function cardLeafTexts($: CheerioAPI, card: Cheerio<AnyNode>): string[] {
  const values: string[] = [];
  card.find("*").each((_index, element) => {
    const current = $(element);
    if (current.children().length > 0) return;
    const text = current.text().replace(/\s+/g, " ").trim();
    if (text && text.length <= 180) values.push(text);
  });
  return values;
}

function uniqueMznIds(card: Cheerio<AnyNode>): Set<string> {
  const ids = new Set<string>();
  card.find("a[href]").each((_index, element) => {
    const href = element.attribs.href;
    const id = href ? listingIdFromHref(href) : null;
    if (id) ids.add(id.toLowerCase());
  });
  return ids;
}

function listingFields($: CheerioAPI, card: Cheerio<AnyNode>): { pricePln: number | null; areaM2: number | null; rooms: number | null } {
  const leafTexts = cardLeafTexts($, card);
  const pricePln = leafTexts
    .filter((value) => /\d[\d\s.,]*\s*(?:zł|pln)(?![a-z])/i.test(value) && !/(?:\/|za\s*)\s*(?:m²|m2)/i.test(value))
    .map(parsePricePln)
    .find((value) => value !== null) ?? null;
  const areaM2 = leafTexts
    .filter((value) => /(?:m²|m2)(?![a-z0-9])/i.test(value))
    .map(parseAreaM2)
    .find((value) => value !== null) ?? null;
  const rooms = leafTexts.map(parseRoomCount).find((value) => value !== null) ?? null;
  return { pricePln, areaM2, rooms };
}

function findCardFields($: CheerioAPI, anchor: Cheerio<AnyNode>): ReturnType<typeof listingFields> {
  let current = anchor.parent();
  let bestFields = listingFields($, current);
  let bestScore = Object.values(bestFields).filter((value) => value !== null).length;

  for (let depth = 0; depth < 8 && current.length; depth += 1) {
    if (uniqueMznIds(current).size > 1) break;
    const fields = listingFields($, current);
    const score = Object.values(fields).filter((value) => value !== null).length;
    if (score > bestScore) {
      bestFields = fields;
      bestScore = score;
    }
    if (score === 3) return fields;
    current = current.parent();
  }

  return bestFields;
}

export function parseMorizonSearchPage(html: string, profile: SearchProfile, capturedAt: string): PageParseResult {
  const $ = load(html);
  const pageText = visibleText($);
  const candidates: NormalizedListing[] = [];
  let mznLinks = 0;

  $("a[href]").each((_index, element) => {
    const href = element.attribs.href;
    if (!href || !listingIdFromHref(href)) return;
    mznLinks += 1;

    let resolvedUrl: URL;
    let canonicalUrl: string;
    try {
      resolvedUrl = new URL(href, SOURCE_URL);
      if (!isSaleApartmentPath(resolvedUrl.pathname)) return;
      canonicalUrl = canonicalizeListingUrl("morizon", resolvedUrl.toString());
    } catch {
      return;
    }

    const externalId = stableExternalId("morizon", canonicalUrl);
    if (!/^mzn\d+$/i.test(externalId)) return;
    const { pricePln, areaM2, rooms } = findCardFields($, $(element));
    candidates.push(
      NormalizedListingSchema.parse({
        source: "morizon",
        externalId,
        canonicalUrl,
        title: null,
        transaction: "sale",
        category: "apartment",
        market: "unknown",
        pricePln,
        areaM2,
        rooms,
        floor: null,
        city: profile.city,
        district: null,
        street: null,
        latitude: null,
        longitude: null,
        publishedAt: null,
        promotedAt: null,
        imageOriginalUrl: null,
        imageAlt: null,
        propertyFeatures: [],
        sourceEvidence: "html",
        capturedAt,
      }),
    );
  });

  const uniqueListings = [...new Map(candidates.map((listing) => [listing.externalId, listing])).values()];
  if (uniqueListings.length > 0) return { kind: "listings", listings: uniqueListings };
  if (mznLinks === 0 && confirmsEmptySearch(pageText)) return { kind: "empty" };
  return { kind: "changed" };
}

function batch(
  profile: SearchProfile,
  input: Omit<FetchBatch, "source" | "profileId">,
): FetchBatch {
  return FetchBatchSchema.parse({
    source: "morizon",
    profileId: profile.id,
    ...input,
    requestCount: input.requestCount ?? input.inspectedPages,
  });
}

function errorMessage(kind: ScrapeErrorKind, status?: number, retryAfter?: string | null): string {
  switch (kind) {
    case "ACCESS_DENIED":
      return `Morizon odmówił dostępu${status ? ` (HTTP ${status})` : ""}; przerwano źródło bez ponawiania.`;
    case "CAPTCHA":
      return "Morizon zwrócił stronę weryfikacyjną; przerwano źródło bez obchodzenia zabezpieczeń.";
    case "RATE_LIMITED":
      return `Morizon ograniczył dostęp (HTTP 429); bez ponowienia w tym przebiegu.${retryAfter ? ` Retry-After: ${retryAfter.replace(/[\r\n]/g, " ").trim().slice(0, 80)}.` : ""}`;
    case "TIMEOUT":
      return "Odczyt publicznej listy Morizon przekroczył limit czasu.";
    case "PARSE_CHANGED":
      return "Nie rozpoznano oczekiwanych linków ofert sprzedaży mieszkań; markup wymaga ponownej weryfikacji.";
    case "EMPTY_CONFIRMED":
      return "Morizon potwierdził brak wyników dla tej listy.";
    case "UNSUPPORTED":
      return "Morizon zwrócił nieobsługiwaną odpowiedź; bez dalszego pobierania.";
    case "NETWORK":
      return "Nie udało się pobrać publicznej listy Morizon.";
    default:
      return "Wystąpił błąd adaptera Morizon.";
  }
}

function healthStatusForError(kind: ScrapeErrorKind): SourceAccessStatus {
  if (["ACCESS_DENIED", "CAPTCHA", "RATE_LIMITED", "POLICY_BLOCKED"].includes(kind)) {
    return "BLOCKED_BY_ACCESS_OR_POLICY";
  }
  if (kind === "EMPTY_CONFIRMED") return "LIVE_PARTIAL";
  if (kind === "PARSE_CHANGED" || kind === "INTERNAL" || kind === "NETWORK" || kind === "TIMEOUT") {
    return "FAILED";
  }
  return "NOT_TESTED";
}

function errorBatch(
  profile: SearchProfile,
  url: string,
  kind: ScrapeErrorKind,
  inspectedPages: number,
  sourceIsReachable: boolean,
  status?: number,
  requestCount = inspectedPages,
  retryAfter?: string | null,
): FetchBatch {
  return batch(profile, {
    listings: [],
    inspectedPages,
    requestCount,
    isFullTraversal: false,
    sourceIsReachable,
    warnings: [],
    errors: [{ kind, message: errorMessage(kind, status, retryAfter), url }],
  });
}

function contentTypeIsHtml(contentType: string | null): boolean {
  if (!contentType) return false;
  return /^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType.trim());
}

export class MorizonSourceAdapter implements SourceAdapter {
  readonly source = "morizon" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly minHostIntervalMs: number;
  private readonly hostJitterMs: number;
  private readonly now: () => Date;
  private lastHealthStatus: SourceAccessStatus = "NOT_TESTED";
  private lastHealthDiagnostic = "Brak jeszcze próby pobrania publicznej listy.";

  constructor(options: MorizonAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.minHostIntervalMs = options.minHostIntervalMs ?? MIN_HOST_INTERVAL_MS;
    this.hostJitterMs = options.hostJitterMs ?? HOST_JITTER_MS;
    this.now = options.now ?? (() => new Date());
  }

  async discover(profile: SearchProfile, options: { dryRun: boolean; maxPages: number; since?: string; verbose?: boolean; signal?: AbortSignal }): Promise<FetchBatch> {
    void options.dryRun;
    const url = morizonSearchUrl(profile.city);
    const requestedPageCount = Number.isFinite(options.maxPages) ? Math.max(0, Math.floor(options.maxPages)) : 1;
    const pageBudget = Math.min(requestedPageCount, MAX_PAGES_PER_PROFILE);
    if (pageBudget === 0) {
      this.lastHealthStatus = "NOT_TESTED";
      this.lastHealthDiagnostic = "Nie pobrano strony: maxPages wynosi 0.";
      return batch(profile, {
        listings: [],
        inspectedPages: 0,
        isFullTraversal: false,
        sourceIsReachable: false,
        warnings: ["Morizon ogranicza każde wyszukiwanie do jednej strony; nie uruchomiono żądania."],
        errors: [],
      });
    }

    let response: Response;
    let html: string;
    let requestCount = 0;
    try {
      const { value: fetched } = await retryTransient(
        () => withMorizonHostRateLimit(
          options.signal,
          () => withRequestTimeout(this.requestTimeoutMs, options.signal, async (requestSignal) => {
            requestCount += 1;
            const received = await this.fetchImpl(url, {
              method: "GET",
              headers: {
                accept: "text/html,application/xhtml+xml;q=0.9",
                "accept-language": "pl-PL,pl;q=0.8",
                "user-agent": "RealtyWatch/0.1 (personal property-purchase search)",
              },
              redirect: "manual",
              signal: requestSignal,
            });
            if (received.status >= 300 && received.status < 400) {
              throw new MorizonRequestError("NETWORK");
            }
            if (received.ok && !contentTypeIsHtml(received.headers.get("content-type"))) {
              throw new MorizonRequestError("NETWORK");
            }
            const body = received.ok ? await readHtml(received, MAX_HTML_BYTES) : "";
            return { response: received, html: body };
          }),
          this.minHostIntervalMs,
          this.hostJitterMs,
        ),
        {
          signal: options.signal,
          shouldRetryValue: ({ response: received }) => received.status === 408 || received.status === 504 || received.status >= 500,
          shouldRetryError: (error) => error instanceof MorizonRequestError && error.retryable,
          disposeValue: async ({ response: received }) => { await received.body?.cancel(); },
        },
      );
      ({ response, html } = fetched);
    } catch (error) {
      const kind: ScrapeErrorKind = error instanceof MorizonRequestError ? error.kind : options.signal?.aborted ? "TIMEOUT" : "NETWORK";
      this.lastHealthStatus = healthStatusForError(kind);
      this.lastHealthDiagnostic = errorMessage(kind);
      return errorBatch(profile, url, kind, requestCount > 0 ? 1 : 0, false, undefined, requestCount);
    }

    if (!response.ok) await response.body?.cancel();
    const statusError = morizonHttpErrorKind(response.status);
    if (statusError) {
      this.lastHealthStatus = healthStatusForError(statusError);
      const retryAfter = response.headers.get("retry-after");
      this.lastHealthDiagnostic = errorMessage(statusError, response.status, retryAfter);
      return errorBatch(profile, url, statusError, 1, true, response.status, requestCount, retryAfter);
    }

    if (hasCaptchaChallenge(html)) {
      this.lastHealthStatus = healthStatusForError("CAPTCHA");
      this.lastHealthDiagnostic = errorMessage("CAPTCHA");
      return errorBatch(profile, url, "CAPTCHA", 1, true, undefined, requestCount);
    }

    const parsed = parseMorizonSearchPage(html, profile, this.now().toISOString());
    if (parsed.kind === "empty") {
      this.lastHealthStatus = "LIVE_PARTIAL";
      this.lastHealthDiagnostic = "Publiczna strona odpowiada; lista potwierdziła brak wyników. DB/UI niezweryfikowane.";
      return errorBatch(profile, url, "EMPTY_CONFIRMED", 1, true, undefined, requestCount);
    }
    if (parsed.kind === "changed") {
      this.lastHealthStatus = healthStatusForError("PARSE_CHANGED");
      this.lastHealthDiagnostic = errorMessage("PARSE_CHANGED");
      return errorBatch(profile, url, "PARSE_CHANGED", 1, true, undefined, requestCount);
    }

    const incompleteCount = parsed.listings.filter(
      (listing) => listing.pricePln === null || listing.areaM2 === null || listing.rooms === null,
    ).length;
    const warnings = incompleteCount > 0 ? ["Część pól ceny, metrażu lub pokoi była niedostępna i pozostała null."] : [];
    this.lastHealthStatus = "LIVE_PARTIAL";
    this.lastHealthDiagnostic = `Publiczna lista sparsowana; DB/UI niezweryfikowane (${parsed.listings.length} rekordów).`;
    return batch(profile, {
      listings: parsed.listings,
      inspectedPages: 1,
      requestCount,
      isFullTraversal: false,
      sourceIsReachable: true,
      warnings,
      errors: [],
    });
  }

  async healthcheck(): Promise<{ status: SourceAccessStatus; diagnostic?: string }> {
    return { status: this.lastHealthStatus, diagnostic: this.lastHealthDiagnostic };
  }
}

export function classifyMorizonFetchFailure(error: unknown): "TIMEOUT" | "NETWORK" {
  return error instanceof MorizonRequestError ? error.kind : "NETWORK";
}
