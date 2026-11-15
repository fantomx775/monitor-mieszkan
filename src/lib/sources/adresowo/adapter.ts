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
import { normalizeAdresowoSearchUrl } from "./search-url";

const SOURCE = "adresowo" as const;
const MAX_PAGES_PER_PROFILE = 20;
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_HOST_INTERVAL_MS = 2_500;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_TITLE_LENGTH = 500;

type ScrapeErrorKind = FetchBatch["errors"][number]["kind"];
type PageParseResult =
  | { kind: "listings"; listings: NormalizedListing[] }
  | { kind: "empty" }
  | { kind: "changed" };

export type AdresowoAdapterOptions = {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  minHostIntervalMs?: number;
  now?: () => Date;
};

class AdresowoRequestError extends Error {
  constructor(readonly kind: ScrapeErrorKind, readonly status?: number) {
    super("Adresowo request failed");
    this.name = "AdresowoRequestError";
  }
}

class ResponseTooLargeError extends Error {
  constructor(readonly status: number) {
    super("Adresowo response exceeded the configured size limit");
  }
}

let hostRequestQueue: Promise<void> = Promise.resolve();
let lastHostRequestAt = 0;

function normalizePlace(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[łŁ]/g, "l")
    .toLocaleLowerCase("pl-PL")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
}

function parseIsoDate(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const timestamp = Date.parse(value.trim());
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function cardTextSegments($: CheerioAPI, card: Cheerio<AnyNode>): string[] {
  const values: string[] = [];
  card.find("*").not("script, style, noscript, template").each((_index, element) => {
    const current = $(element);
    const text = collapseWhitespace(current.text());
    if (text && text.length <= 180) values.push(text);

    for (const attribute of ["aria-label", "title", "data-price", "data-area", "data-rooms", "content"]) {
      const value = current.attr(attribute);
      if (value) {
        const normalizedValue = collapseWhitespace(value);
        if (normalizedValue && normalizedValue.length <= 180) values.push(normalizedValue);
      }
    }
  });
  return [...new Set(values)].sort((left, right) => left.length - right.length);
}

function parseRooms(values: string[]): number | null {
  for (const value of values) {
    const common = parseRoomCount(value);
    if (common !== null) return common;
    const propertyStyle = value.match(/\b(\d{1,2})[\s-]*pokoj(?:owe|owy|owego|owych|owe|e|i|ów)\b/i);
    if (propertyStyle) {
      const rooms = Number(propertyStyle[1]);
      if (Number.isSafeInteger(rooms) && rooms > 0) return rooms;
    }
    const abbreviated = value.match(/\b(\d{1,2})[\s-]*pok(?:\.|\b)/i);
    if (abbreviated) {
      const rooms = Number(abbreviated[1]);
      if (Number.isSafeInteger(rooms) && rooms > 0) return rooms;
    }
  }
  return null;
}

function listingFields($: CheerioAPI, card: Cheerio<AnyNode>): {
  pricePln: number | null;
  areaM2: number | null;
  rooms: number | null;
} {
  const textSegments = cardTextSegments($, card);
  const pricePln = textSegments
    .filter((text) => /\d[\d\s.,]*\s*(?:zł|pln)(?![a-z])/i.test(text))
    .filter((text) => !/(?:zł|pln)\s*\/\s*(?:m²|m2)/i.test(text))
    .map(parsePricePln)
    .find((value) => value !== null) ?? null;
  const areaM2 = textSegments
    .filter((text) => /(?:m²|m2)(?![a-z0-9])/i.test(text))
    .filter((text) => !/(?:zł|pln)\s*\/\s*(?:m²|m2)/i.test(text))
    .map(parseAreaM2)
    .find((value) => value !== null) ?? null;
  const rooms = parseRooms(textSegments);
  return { pricePln, areaM2, rooms };
}

function titleFromCard($: CheerioAPI, card: Cheerio<AnyNode>): string | null {
  const anchor = card.find('h2 a[href^="/o/"]').first();
  const title = collapseWhitespace(anchor.text());
  if (!title) return null;
  return title.length <= MAX_TITLE_LENGTH ? title : title.slice(0, MAX_TITLE_LENGTH).trim();
}

function districtFromSearchUrl(searchUrl: string, profile: SearchProfile): string | null {
  const routeSegments = new URL(searchUrl).pathname
    .split("/")
    .filter(Boolean)
    .map(normalizePlace);
  return profile.preferredDistricts.find((district) => {
    const tokens = normalizePlace(district).split(" ").filter((token) => token.length >= 4);
    return tokens.some((token) => routeSegments.some((segment) => segment.includes(token)));
  }) ?? null;
}

function publishedAtFromCard(card: Cheerio<AnyNode>): string | null {
  const datetime = card.find("time[datetime]").first().attr("datetime");
  if (datetime) return parseIsoDate(datetime);
  for (const attribute of ["data-published-at", "data-date-created", "data-created-at"]) {
    const value = card.attr(attribute);
    const parsed = parseIsoDate(value);
    if (parsed) return parsed;
  }
  return null;
}

function cardListing(
  $: CheerioAPI,
  card: Cheerio<AnyNode>,
  profile: SearchProfile,
  district: string | null,
  capturedAt: string,
): NormalizedListing | null {
  const externalId = card.attr("data-id")?.trim();
  const href = card.find('h2 a[href^="/o/"]').first().attr("href");
  if (!externalId || !href) return null;

  let canonicalUrl: string;
  try {
    const listingUrl = new URL(href, "https://adresowo.pl/");
    listingUrl.search = "";
    listingUrl.hash = "";
    canonicalUrl = canonicalizeListingUrl("adresowo", listingUrl.toString());
  } catch {
    return null;
  }

  const fields = listingFields($, card);
  const title = titleFromCard($, card);
  const normalizedTitle = normalizePlace(title ?? "");
  const targetCity = normalizePlace(profile.city);
  const titleConfirmsCity = normalizedTitle.includes(targetCity);
  const titleConfirmsDistrict = district
    ? normalizedTitle.includes(normalizePlace(district.replace(/^osiedle\s+/i, "")))
    : false;
  const verifiedDistrict = titleConfirmsDistrict
    ? normalizedTitle.includes("paderewskiego muchowiec")
      ? "Osiedle Paderewskiego-Muchowiec"
      : district
    : null;
  const candidate = {
    source: SOURCE,
    externalId: stableExternalId(SOURCE, canonicalUrl, externalId),
    canonicalUrl,
    title,
    transaction: "sale" as const,
    category: "apartment" as const,
    market: "unknown" as const,
    pricePln: fields.pricePln,
    areaM2: fields.areaM2,
    rooms: fields.rooms,
    floor: null,
    city: profile.mode === "strict" ? (titleConfirmsCity ? profile.city : null) : profile.city,
    district: profile.mode === "strict" ? verifiedDistrict : district,
    street: null,
    latitude: null,
    longitude: null,
    publishedAt: publishedAtFromCard(card),
    promotedAt: null,
    imageOriginalUrl: null,
    imageAlt: null,
    propertyFeatures: [],
    sourceEvidence: "html" as const,
    capturedAt,
  };
  const parsed = NormalizedListingSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function confirmsEmptySearch(text: string): boolean {
  const normalized = text.toLocaleLowerCase("pl-PL").replace(/\s+/g, " ");
  return [
    "nie znaleziono ogłoszeń",
    "nie znaleźliśmy ogłoszeń",
    "brak ogłoszeń spełniających kryteria",
    "brak ofert spełniających kryteria",
    "nie znaleziono ofert",
  ].some((marker) => normalized.includes(marker));
}

function hasCaptchaChallenge($: CheerioAPI): boolean {
  const body = $("body").clone();
  body.find("script, style, noscript, template").remove();
  const text = collapseWhitespace(body.text());
  const normalized = text.toLocaleLowerCase("pl-PL").replace(/\s+/g, " ");
  return [
    "captcha",
    "datadome",
    "cf-chl-",
    "verify you are human",
    "checking your browser",
    "potwierdź, że nie jesteś robotem",
    "sprawdź, czy nie jesteś robotem",
    "wykryliśmy nietypowy ruch",
  ].some((marker) => normalized.includes(marker));
}

function pageNumber(url: URL): number {
  const match = url.pathname.match(/\/_l(\d+)\/?$/i);
  return match ? Number(match[1]) : 1;
}

function searchPath(url: URL): string {
  return url.pathname
    .replace(/\/_l\d+\/?$/i, "/")
    .replace(/\/+$/, "")
    .toLocaleLowerCase("pl-PL");
}

function nextPageUrl($: CheerioAPI, currentUrl: string): string | null {
  let current: URL;
  try {
    current = new URL(normalizeAdresowoSearchUrl(currentUrl));
  } catch {
    return null;
  }

  const expectedPage = pageNumber(current) + 1;
  const candidates: Array<{ url: string; priority: number }> = [];
  $('link[rel~="next"], a[href]').each((_index, element) => {
    const currentElement = $(element);
    const href = currentElement.attr("href");
    if (!href) return;

    let resolved: URL;
    try {
      resolved = new URL(href, current);
    } catch {
      return;
    }
    if (resolved.origin !== current.origin) return;

    let candidate: URL;
    try {
      candidate = new URL(normalizeAdresowoSearchUrl(resolved.toString()));
    } catch {
      return;
    }

    if (
      candidate.origin !== current.origin
      || searchPath(candidate) !== searchPath(current)
      || candidate.search !== current.search
      || pageNumber(candidate) !== expectedPage
    ) return;

    const label = [
      currentElement.attr("rel"),
      currentElement.attr("aria-label"),
      currentElement.attr("title"),
      collapseWhitespace(currentElement.text()),
    ].filter(Boolean).join(" ");
    const isExplicitNext = /(?:next|następ|dalej)/i.test(label);
    candidates.push({ url: candidate.toString(), priority: isExplicitNext ? 0 : 1 });
  });

  candidates.sort((left, right) => left.priority - right.priority);
  return candidates[0]?.url ?? null;
}

function parseSearchPage(
  html: string,
  pageUrl: string,
  profile: SearchProfile,
  capturedAt: string,
): PageParseResult {
  const $ = load(html);
  const cards = $('[data-offer-card][data-id]');
  if (!cards.length) {
    return confirmsEmptySearch($("body").text()) ? { kind: "empty" } : { kind: "changed" };
  }

  const district = districtFromSearchUrl(pageUrl, profile);
  const listings = new Map<string, NormalizedListing>();
  cards.each((_index, element) => {
    const listing = cardListing($, $(element), profile, district, capturedAt);
    if (listing) listings.set(listing.externalId, listing);
  });
  return listings.size ? { kind: "listings", listings: [...listings.values()] } : { kind: "changed" };
}

function errorMessage(kind: ScrapeErrorKind, status?: number): string {
  switch (kind) {
    case "ACCESS_DENIED":
      return `Adresowo odmówiło dostępu${status ? ` (HTTP ${status})` : ""}; przerwano źródło.`;
    case "CAPTCHA":
      return "Adresowo zwróciło stronę weryfikacyjną; przerwano bez obchodzenia zabezpieczeń.";
    case "RATE_LIMITED":
      return "Adresowo ograniczyło częstotliwość żądań (HTTP 429); nie ponawiano.";
    case "TIMEOUT":
      return "Odczyt wyników Adresowo przekroczył limit czasu.";
    case "PARSE_CHANGED":
      return "Strona nie zawiera rozpoznanych kart [data-offer-card][data-id]; parser wymaga aktualizacji.";
    case "EMPTY_CONFIRMED":
      return "Adresowo zwróciło poprawną listę bez ofert dla tego wyszukiwania.";
    case "UNSUPPORTED":
      return "Profil wymaga pełnego linku wyników mieszkań pod ścieżką /f/mieszkania/.";
    case "NETWORK":
      return "Nie udało się pobrać publicznej strony wyników Adresowo.";
    default:
      return "Wystąpił błąd adaptera Adresowo.";
  }
}

function batch(profile: SearchProfile, fields: Omit<FetchBatch, "source" | "profileId">): FetchBatch {
  return FetchBatchSchema.parse({
    source: SOURCE,
    profileId: profile.id,
    ...fields,
    requestCount: fields.requestCount ?? fields.inspectedPages,
  });
}

function errorBatch(
  profile: SearchProfile,
  kind: ScrapeErrorKind,
  requestCount: number,
  inspectedPages: number,
  sourceIsReachable: boolean,
  status?: number,
  listings: NormalizedListing[] = [],
  warnings: string[] = [],
): FetchBatch {
  return batch(profile, {
    listings,
    inspectedPages,
    requestCount,
    isFullTraversal: false,
    sourceIsReachable,
    warnings,
    errors: [{ kind, message: errorMessage(kind, status) }],
  });
}

function httpErrorKind(status: number): ScrapeErrorKind | null {
  if ([401, 403, 451].includes(status)) return "ACCESS_DENIED";
  if (status === 429) return "RATE_LIMITED";
  if ([408, 504].includes(status)) return "TIMEOUT";
  if (status >= 300 && status < 400) return "UNSUPPORTED";
  if (status >= 400) return "NETWORK";
  return null;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withHostRateLimit<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
  minIntervalMs: number,
): Promise<T> {
  const queued = hostRequestQueue.then(async () => {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    const waitMs = lastHostRequestAt + minIntervalMs - Date.now();
    if (waitMs > 0) await delay(waitMs, signal);
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    lastHostRequestAt = Date.now();
    return operation();
  });
  hostRequestQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

async function readHtml(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(response.status);
  }

  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let byteCount = 0;
  let html = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new ResponseTooLargeError(response.status);
    }
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

async function requestPage(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ response: Response; html: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9",
        "accept-language": "pl-PL,pl;q=0.8",
        "user-agent": "RealtyWatch/0.1 (personal property-purchase search)",
      },
      signal: controller.signal,
    });
    const kind = httpErrorKind(response.status);
    if (kind) {
      await response.body?.cancel();
      throw new AdresowoRequestError(kind, response.status);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AdresowoRequestError("NETWORK", response.status);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType.trim())) {
      await response.body?.cancel();
      throw new AdresowoRequestError("UNSUPPORTED", response.status);
    }
    return { response, html: await readHtml(response) };
  } catch (error) {
    if (error instanceof AdresowoRequestError || error instanceof ResponseTooLargeError) throw error;
    if (signal?.aborted || timedOut) throw new AdresowoRequestError("TIMEOUT");
    throw new AdresowoRequestError("NETWORK");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function healthStatusForError(kind: ScrapeErrorKind): SourceAccessStatus {
  if (["ACCESS_DENIED", "CAPTCHA", "RATE_LIMITED", "POLICY_BLOCKED"].includes(kind)) {
    return "BLOCKED_BY_ACCESS_OR_POLICY";
  }
  if (kind === "UNSUPPORTED") return "NOT_TESTED";
  return "FAILED";
}

export class AdresowoSourceAdapter implements SourceAdapter {
  readonly source = SOURCE;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly minHostIntervalMs: number;
  private readonly now: () => Date;
  private lastHealthStatus: SourceAccessStatus = "NOT_TESTED";
  private lastHealthDiagnostic = "Brak jeszcze odczytu wyników Adresowo.";

  constructor(options: AdresowoAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.minHostIntervalMs = options.minHostIntervalMs ?? MIN_HOST_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
  }

  async discover(
    profile: SearchProfile,
    options: { dryRun: boolean; maxPages: number; since?: string; verbose?: boolean; signal?: AbortSignal },
  ): Promise<FetchBatch> {
    void options.dryRun;
    const requestedPages = Number.isFinite(options.maxPages) ? Math.max(0, Math.floor(options.maxPages)) : 1;
    const pageBudget = Math.min(requestedPages, MAX_PAGES_PER_PROFILE);
    if (pageBudget === 0) {
      const diagnostic = "Nie wysłano żądania: budżet stron wynosi 0.";
      this.lastHealthStatus = "NOT_TESTED";
      this.lastHealthDiagnostic = diagnostic;
      return batch(profile, {
        listings: [], inspectedPages: 0, requestCount: 0, isFullTraversal: false,
        sourceIsReachable: false, warnings: [diagnostic], errors: [],
      });
    }

    if (!profile.adresowoSearchUrl) {
      this.lastHealthStatus = "NOT_TESTED";
      this.lastHealthDiagnostic = errorMessage("UNSUPPORTED");
      return errorBatch(profile, "UNSUPPORTED", 0, 0, false);
    }

    let firstPageUrl: string;
    try {
      firstPageUrl = normalizeAdresowoSearchUrl(profile.adresowoSearchUrl);
    } catch {
      this.lastHealthStatus = "NOT_TESTED";
      this.lastHealthDiagnostic = errorMessage("UNSUPPORTED");
      return errorBatch(profile, "UNSUPPORTED", 0, 0, false);
    }

    const visited = new Set<string>();
    const listings = new Map<string, NormalizedListing>();
    const warnings: string[] = [];
    let currentUrl: string | null = firstPageUrl;
    let requestCount = 0;
    let inspectedPages = 0;
    let sourceIsReachable = false;
    let hasUnvisitedNextPage = false;

    while (currentUrl && inspectedPages < pageBudget) {
      if (visited.has(currentUrl)) {
        warnings.push("Wykryto powtórzony link paginacji; dalsze pobieranie przerwano.");
        hasUnvisitedNextPage = false;
        break;
      }
      visited.add(currentUrl);
      if (options.signal?.aborted) {
        const kind: ScrapeErrorKind = "TIMEOUT";
        this.lastHealthStatus = healthStatusForError(kind);
        this.lastHealthDiagnostic = errorMessage(kind);
        return errorBatch(profile, kind, requestCount, inspectedPages, sourceIsReachable, undefined, [...listings.values()], warnings);
      }

      let fetched: { response: Response; html: string };
      try {
        requestCount += 1;
        fetched = await withHostRateLimit(
          options.signal,
          () => requestPage(this.fetchImpl, currentUrl!, this.requestTimeoutMs, options.signal),
          this.minHostIntervalMs,
        );
      } catch (error) {
        const kind = error instanceof AdresowoRequestError
          ? error.kind
          : error instanceof ResponseTooLargeError ? "UNSUPPORTED"
            : options.signal?.aborted ? "TIMEOUT" : "NETWORK";
        const status = error instanceof AdresowoRequestError || error instanceof ResponseTooLargeError
          ? error.status : undefined;
        const reached = status !== undefined;
        sourceIsReachable ||= reached;
        this.lastHealthStatus = healthStatusForError(kind);
        this.lastHealthDiagnostic = errorMessage(kind, status);
        return errorBatch(profile, kind, requestCount, inspectedPages, sourceIsReachable, status, [...listings.values()], warnings);
      }

      sourceIsReachable = true;
      inspectedPages += 1;
      const $ = load(fetched.html);
      if (hasCaptchaChallenge($)) {
        const kind: ScrapeErrorKind = "CAPTCHA";
        this.lastHealthStatus = healthStatusForError(kind);
        this.lastHealthDiagnostic = errorMessage(kind);
        return errorBatch(profile, kind, requestCount, inspectedPages, true, undefined, [...listings.values()], warnings);
      }

      const parsed = parseSearchPage(fetched.html, currentUrl, profile, this.now().toISOString());
      if (parsed.kind === "changed") {
        const kind: ScrapeErrorKind = "PARSE_CHANGED";
        this.lastHealthStatus = healthStatusForError(kind);
        this.lastHealthDiagnostic = errorMessage(kind);
        return errorBatch(profile, kind, requestCount, inspectedPages, true, undefined, [...listings.values()], warnings);
      }
      if (parsed.kind === "empty") {
        warnings.push("Adresowo potwierdziło pustą listę wyników; pobieranie zakończono.");
        hasUnvisitedNextPage = false;
        break;
      }

      for (const listing of parsed.listings) {
        if (listings.has(listing.externalId)) {
          warnings.push("Pominięto powtórzony identyfikator oferty.");
          continue;
        }
        listings.set(listing.externalId, listing);
      }

      const next = nextPageUrl($, currentUrl);
      hasUnvisitedNextPage = Boolean(next && !visited.has(next));
      currentUrl = hasUnvisitedNextPage ? next : null;
    }

    if (hasUnvisitedNextPage) {
      warnings.push(`Osiągnięto limit ${pageBudget} stron; pozostał jawny link do kolejnej strony.`);
    } else {
      warnings.push("Pobierano wyłącznie strony wyników połączone jawnym linkiem paginacji; pełna liczba wyników nie była dostępna w HTML.");
    }

    const incomplete = [...listings.values()].filter((listing) =>
      listing.pricePln === null || listing.areaM2 === null || listing.rooms === null,
    ).length;
    if (incomplete) warnings.push(`${incomplete} ofert nie zawierało ceny, metrażu lub liczby pokoi.`);

    this.lastHealthStatus = "LIVE_PARTIAL";
    this.lastHealthDiagnostic = `Odczytano ${listings.size} unikalnych ofert z ${inspectedPages} stron; DB/UI niezweryfikowane.`;
    return batch(profile, {
      listings: [...listings.values()],
      inspectedPages,
      requestCount,
      isFullTraversal: false,
      sourceIsReachable,
      warnings,
      errors: [],
    });
  }

  async healthcheck(): Promise<{ status: SourceAccessStatus; diagnostic?: string }> {
    return { status: this.lastHealthStatus, diagnostic: this.lastHealthDiagnostic };
  }
}

export const adresowoAdapter = new AdresowoSourceAdapter();
