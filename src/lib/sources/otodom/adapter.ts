import {
  FetchBatchSchema,
  NormalizedListingSchema,
  type FetchBatch,
  type NormalizedListing,
  type SearchProfile,
  type SourceAccessStatus,
  type SourceAdapter,
} from "../contracts";
import { canonicalizeListingUrl } from "../normalization";
import { normalizeOtodomSearchUrl, otodomSearchPageUrl } from "./search-url";

const SOURCE = "otodom" as const;
const OTODOM_ORIGIN = "https://www.otodom.pl";
const MAX_PAGES_PER_PROFILE = 20;
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_HOST_INTERVAL_MS = 2_500;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_TITLE_LENGTH = 500;

type RecordValue = Record<string, unknown>;
type ScrapeErrorKind = FetchBatch["errors"][number]["kind"];
type PageParseResult =
  | { kind: "listings"; listings: NormalizedListing[]; page: number; totalPages: number; totalItems: number }
  | { kind: "empty"; page: number; totalPages: number; totalItems: number }
  | { kind: "changed" };

export type OtodomAdapterOptions = {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  minHostIntervalMs?: number;
  now?: () => Date;
};

class OtodomRequestError extends Error {
  constructor(readonly kind: ScrapeErrorKind, readonly status?: number) {
    super("Otodom request failed");
    this.name = "OtodomRequestError";
  }
}

class ResponseTooLargeError extends Error {}

let hostRequestQueue: Promise<void> = Promise.resolve();
let lastHostRequestAt = 0;

function asRecord(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asPositiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim().replace(",", "."))
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function asPositiveInteger(value: unknown): number | null {
  const parsed = asPositiveNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizePlace(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[łŁ]/g, "l")
    .toLocaleLowerCase("pl-PL")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function shortTitle(value: unknown): string | null {
  const title = asText(value)?.replace(/\s+/g, " ") ?? null;
  if (!title) return null;
  return title.length <= MAX_TITLE_LENGTH ? title : title.slice(0, MAX_TITLE_LENGTH).trim();
}

function dateToIso(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function floorNumber(value: unknown): number | null {
  const text = asText(value);
  if (!text) return null;
  if (/^(?:parter|ground floor)$/i.test(text)) return 0;
  const match = text.match(/^-?\d{1,3}$/);
  return match ? Number(match[0]) : null;
}

function locationData(item: RecordValue, profile: SearchProfile): {
  city: string;
  district: string | null;
} {
  const location = asRecord(item.location);
  const address = asRecord(location?.address);
  const reverseGeocoding = asRecord(location?.reverseGeocoding);
  const rawLocations = reverseGeocoding?.locations;
  const places = Array.isArray(rawLocations)
    ? rawLocations.map(asRecord).filter((place): place is RecordValue => place !== null)
    : [];

  const names = places.flatMap((place) => [asText(place.name), asText(place.fullName)]).filter((name): name is string => name !== null);
  const cityPlace = places.find((place) => /city|town|locality|municipality/i.test(asText(place.locationLevel) ?? ""));
  const city = asText(address?.city)
    ?? asText(cityPlace?.name)
    ?? profile.city;
  const districtPlace = places.find((place) => /district|neighbou?rhood|microdistrict|suburb/i.test(asText(place.locationLevel) ?? ""));
  const preferredDistrict = profile.preferredDistricts.find((preferred) =>
    names.some((name) => normalizePlace(name).includes(normalizePlace(preferred))),
  );

  return {
    city,
    district: asText(districtPlace?.name) ?? preferredDistrict ?? null,
  };
}

function listingUrl(slugValue: unknown): string | null {
  const slug = asText(slugValue);
  if (!slug) return null;
  try {
    const candidate = /^https?:\/\//i.test(slug)
      ? slug
      : `${OTODOM_ORIGIN}${slug.startsWith("/") ? slug : `/pl/oferta/${slug}`}`;
    const url = new URL(candidate);
    if (!/(^|\.)otodom\.pl$/i.test(url.hostname) || !url.pathname.startsWith("/pl/oferta/")) return null;
    return canonicalizeListingUrl(SOURCE, url.toString());
  } catch {
    return null;
  }
}

function mapListing(itemValue: unknown, profile: SearchProfile, capturedAt: string): NormalizedListing | null {
  const item = asRecord(itemValue);
  if (!item) return null;

  const externalId = asText(item.id);
  const canonicalUrl = listingUrl(item.slug);
  if (!externalId || !canonicalUrl) return null;

  const place = locationData(item, profile);
  const normalizedCity = normalizePlace(place.city);
  if (normalizedCity && normalizedCity !== normalizePlace(profile.city)) return null;

  const totalPrice = asRecord(item.totalPrice);
  const currency = asText(totalPrice?.currency)?.toUpperCase();
  const priceValue = item.hidePrice === true || (currency && currency !== "PLN") ? null : asPositiveNumber(totalPrice?.value);
  const areaM2 = asPositiveNumber(item.areaInSquareMeters);
  const rooms = asPositiveInteger(item.roomsNumber);
  const floor = floorNumber(item.floorNumber);

  const parsed = NormalizedListingSchema.safeParse({
    source: SOURCE,
    externalId,
    canonicalUrl,
    title: shortTitle(item.title),
    transaction: "sale",
    category: "apartment",
    market: "unknown",
    pricePln: priceValue !== null && Number.isSafeInteger(priceValue) ? priceValue : null,
    areaM2,
    rooms,
    floor,
    city: place.city.slice(0, 160),
    district: place.district?.slice(0, 160) ?? null,
    street: null,
    latitude: null,
    longitude: null,
    publishedAt: dateToIso(item.dateCreated) ?? dateToIso(item.createdAtFirst),
    promotedAt: null,
    imageOriginalUrl: null,
    imageAlt: null,
    propertyFeatures: [],
    sourceEvidence: "html",
    capturedAt,
  });

  return parsed.success ? parsed.data : null;
}

function parseNextData(html: string): RecordValue | null {
  const match = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try {
    return asRecord(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

export function parseOtodomSearchPage(
  html: string,
  profile: SearchProfile,
  capturedAt: string,
  expectedPage = 1,
): PageParseResult {
  const nextData = parseNextData(html);
  const props = asRecord(nextData?.props);
  const pageProps = asRecord(props?.pageProps);
  const data = asRecord(pageProps?.data);
  const searchAds = asRecord(data?.searchAds);
  const pagination = asRecord(searchAds?.pagination);
  const items = searchAds?.items;
  const currentPage = asPositiveInteger(pagination?.currentPage);
  const totalPages = asPositiveInteger(pagination?.totalPages);
  const totalItems = asNonNegativeInteger(pagination?.totalItems);

  if (!Array.isArray(items) || !currentPage || !totalPages || totalItems === null || currentPage !== expectedPage) {
    return { kind: "changed" };
  }
  if (items.length === 0) return { kind: "empty", page: currentPage, totalPages, totalItems };

  const listings = new Map<string, NormalizedListing>();
  for (const item of items) {
    const listing = mapListing(item, profile, capturedAt);
    if (listing) listings.set(listing.externalId, listing);
  }
  return listings.size
    ? { kind: "listings", listings: [...listings.values()], page: currentPage, totalPages, totalItems }
    : { kind: "changed" };
}

function hasCaptchaChallenge(html: string): boolean {
  const normalized = html.toLocaleLowerCase("pl-PL").replace(/\s+/g, " ");
  return [
    "captcha",
    "verify you are human",
    "checking your browser",
    "datadome",
    "cf-chl-",
    "wykryliśmy nietypowy ruch",
    "potwierdź, że nie jesteś robotem",
  ].some((marker) => normalized.includes(marker));
}

function errorMessage(kind: ScrapeErrorKind, status?: number): string {
  switch (kind) {
    case "ACCESS_DENIED":
      return `Otodom odmówił dostępu${status ? ` (HTTP ${status})` : ""}; przerwano źródło.`;
    case "CAPTCHA":
      return "Otodom zwrócił stronę weryfikacyjną; przerwano bez obchodzenia zabezpieczeń.";
    case "RATE_LIMITED":
      return "Otodom ograniczył częstotliwość żądań (HTTP 429); nie ponawiano.";
    case "TIMEOUT":
      return "Odczyt wyników Otodom przekroczył limit czasu.";
    case "PARSE_CHANGED":
      return "Strona nie zawiera rozpoznanych danych searchAds w __NEXT_DATA__; parser wymaga aktualizacji.";
    case "EMPTY_CONFIRMED":
      return "Otodom zwrócił poprawną listę bez ofert dla tego wyszukiwania.";
    case "UNSUPPORTED":
      return "Profil wymaga pełnego linku do wyników sprzedaży mieszkań na Otodom.";
    case "NETWORK":
      return "Nie udało się pobrać publicznej strony wyników Otodom.";
    default:
      return "Wystąpił błąd adaptera Otodom.";
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
): FetchBatch {
  return batch(profile, {
    listings: [],
    inspectedPages,
    requestCount,
    isFullTraversal: false,
    sourceIsReachable,
    warnings: [],
    errors: [{ kind, message: errorMessage(kind, status) }],
  });
}

function httpErrorKind(status: number): ScrapeErrorKind | null {
  if ([401, 403, 451].includes(status)) return "ACCESS_DENIED";
  if (status === 429) return "RATE_LIMITED";
  if ([408, 504].includes(status)) return "TIMEOUT";
  if (status >= 300 && status < 400) return "UNSUPPORTED";
  if (status >= 400 || status >= 500) return "NETWORK";
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
    throw new ResponseTooLargeError();
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
      throw new ResponseTooLargeError();
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
      throw new OtodomRequestError(kind, response.status);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OtodomRequestError("NETWORK", response.status);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType.trim())) {
      await response.body?.cancel();
      throw new OtodomRequestError("UNSUPPORTED", response.status);
    }
    return { response, html: await readHtml(response) };
  } catch (error) {
    if (error instanceof OtodomRequestError || error instanceof ResponseTooLargeError) throw error;
    if (signal?.aborted || timedOut) throw new OtodomRequestError("TIMEOUT");
    throw new OtodomRequestError("NETWORK");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function sourceHealthForError(kind: ScrapeErrorKind): SourceAccessStatus {
  if (["ACCESS_DENIED", "CAPTCHA", "RATE_LIMITED", "POLICY_BLOCKED"].includes(kind)) {
    return "BLOCKED_BY_ACCESS_OR_POLICY";
  }
  if (kind === "UNSUPPORTED") return "NOT_TESTED";
  return "FAILED";
}

export class OtodomSourceAdapter implements SourceAdapter {
  readonly source = SOURCE;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly minHostIntervalMs: number;
  private readonly now: () => Date;
  private lastHealthStatus: SourceAccessStatus = "NOT_TESTED";
  private lastHealthDiagnostic = "Brak jeszcze odczytu wyników Otodom.";

  constructor(options: OtodomAdapterOptions = {}) {
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
      this.lastHealthStatus = "NOT_TESTED";
      this.lastHealthDiagnostic = "Nie wysłano żądania: budżet stron wynosi 0.";
      return batch(profile, {
        listings: [], inspectedPages: 0, requestCount: 0, isFullTraversal: false,
        sourceIsReachable: false, warnings: [this.lastHealthDiagnostic], errors: [],
      });
    }

    if (!profile.otodomSearchUrl) {
      const diagnostic = "Profil nie ma ustawionego linku do wyników sprzedaży mieszkań Otodom.";
      this.lastHealthStatus = "NOT_TESTED";
      this.lastHealthDiagnostic = diagnostic;
      return errorBatch(profile, "UNSUPPORTED", 0, 0, false);
    }

    let searchUrl: string;
    try {
      searchUrl = normalizeOtodomSearchUrl(profile.otodomSearchUrl);
    } catch {
      this.lastHealthStatus = "NOT_TESTED";
      this.lastHealthDiagnostic = "Profil zawiera nieobsługiwany adres wyszukiwania Otodom.";
      return errorBatch(profile, "UNSUPPORTED", 0, 0, false);
    }

    const listings = new Map<string, NormalizedListing>();
    const warnings: string[] = [];
    const skippedCounts: Record<string, number> = {};
    let requestCount = 0;
    let inspectedPages = 0;
    let totalPages = MAX_PAGES_PER_PROFILE;
    let totalItems = 0;

    for (let page = 1; page <= pageBudget && page <= totalPages; page += 1) {
      if (options.signal?.aborted) {
        const kind: ScrapeErrorKind = "TIMEOUT";
        this.lastHealthStatus = sourceHealthForError(kind);
        this.lastHealthDiagnostic = errorMessage(kind);
        const result = batch(profile, {
          listings: [...listings.values()], inspectedPages, requestCount, isFullTraversal: false,
          sourceIsReachable: inspectedPages > 0, warnings,
          errors: [{ kind, message: errorMessage(kind) }], skippedCounts,
        });
        return result;
      }

      let fetched: { response: Response; html: string };
      try {
        const pageUrl = otodomSearchPageUrl(searchUrl, page);
        fetched = await withHostRateLimit(
          options.signal,
          () => {
            requestCount += 1;
            return requestPage(this.fetchImpl, pageUrl, this.requestTimeoutMs, options.signal);
          },
          this.minHostIntervalMs,
        );
      } catch (error) {
        const kind = error instanceof OtodomRequestError
          ? error.kind
          : error instanceof ResponseTooLargeError ? "UNSUPPORTED"
            : options.signal?.aborted ? "TIMEOUT" : "NETWORK";
        const status = error instanceof OtodomRequestError ? error.status : undefined;
        this.lastHealthStatus = sourceHealthForError(kind);
        this.lastHealthDiagnostic = errorMessage(kind, status);
        return batch(profile, {
          listings: [...listings.values()], inspectedPages, requestCount, isFullTraversal: false,
          sourceIsReachable: error instanceof OtodomRequestError && error.status !== undefined, warnings,
          errors: [{ kind, message: errorMessage(kind, status) }], skippedCounts,
        });
      }

      inspectedPages += 1;
      if (hasCaptchaChallenge(fetched.html)) {
        const kind: ScrapeErrorKind = "CAPTCHA";
        this.lastHealthStatus = sourceHealthForError(kind);
        this.lastHealthDiagnostic = errorMessage(kind);
        return batch(profile, {
          listings: [...listings.values()], inspectedPages, requestCount, isFullTraversal: false,
          sourceIsReachable: true, warnings,
          errors: [{ kind, message: errorMessage(kind) }], skippedCounts,
        });
      }

      const parsed = parseOtodomSearchPage(fetched.html, profile, this.now().toISOString(), page);
      if (parsed.kind === "changed") {
        const kind: ScrapeErrorKind = "PARSE_CHANGED";
        this.lastHealthStatus = sourceHealthForError(kind);
        this.lastHealthDiagnostic = errorMessage(kind);
        return batch(profile, {
          listings: [...listings.values()], inspectedPages, requestCount, isFullTraversal: false,
          sourceIsReachable: true, warnings,
          errors: [{ kind, message: errorMessage(kind) }], skippedCounts,
        });
      }
      if (parsed.kind === "empty") {
        totalPages = parsed.totalPages;
        totalItems = parsed.totalItems;
        if (page === 1) {
          const kind: ScrapeErrorKind = "EMPTY_CONFIRMED";
          this.lastHealthStatus = "LIVE_PARTIAL";
          this.lastHealthDiagnostic = errorMessage(kind);
          return batch(profile, {
            listings: [], inspectedPages, requestCount, isFullTraversal: totalPages === 1,
            sourceIsReachable: true, warnings,
            errors: [{ kind, message: errorMessage(kind) }], skippedCounts,
          });
        }
        warnings.push(`Strona ${page} zawierała pustą listę; przerwano paginację.`);
        break;
      }

      totalPages = parsed.totalPages;
      totalItems = parsed.totalItems;
      let addedOnPage = 0;
      for (const listing of parsed.listings) {
        if (listings.has(listing.externalId)) skippedCounts.duplicate = (skippedCounts.duplicate ?? 0) + 1;
        else {
          listings.set(listing.externalId, listing);
          addedOnPage += 1;
        }
      }
      if (!addedOnPage && parsed.listings.length) {
        warnings.push(`Strona ${page} zawierała wyłącznie powtórzone identyfikatory ofert.`);
        break;
      }
    }

    const incomplete = [...listings.values()].filter((listing) =>
      listing.pricePln === null || listing.areaM2 === null || listing.rooms === null,
    ).length;
    if (incomplete) warnings.push(`${incomplete} ofert nie zawierało ceny, metrażu lub liczby pokoi.`);
    if (listings.size && totalItems && listings.size !== totalItems) {
      warnings.push(`Otodom podał ${totalItems} łącznych wyników i ${listings.size} unikalnych elementów w pobranych stronach.`);
    }
    const isFullTraversal = inspectedPages === totalPages && totalPages <= pageBudget;
    if (!isFullTraversal && totalPages > inspectedPages) {
      warnings.push(`Pobrano ${inspectedPages} z ${totalPages} stron; kolejne strony mieszczą się w następnym budżecie synchronizacji.`);
    }
    this.lastHealthStatus = "LIVE_PARTIAL";
    this.lastHealthDiagnostic = `Odczytano ${listings.size} unikalnych ofert z ${inspectedPages} stron wyników; DB/UI niezweryfikowane.`;
    return batch(profile, {
      listings: [...listings.values()], inspectedPages, requestCount, isFullTraversal,
      sourceIsReachable: true, warnings, skippedCounts, errors: [],
    });
  }

  async healthcheck(): Promise<{ status: SourceAccessStatus; diagnostic?: string }> {
    return { status: this.lastHealthStatus, diagnostic: this.lastHealthDiagnostic };
  }
}
