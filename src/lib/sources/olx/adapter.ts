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
  stableExternalId,
} from "../normalization";

const SOURCE = "olx" as const;
const OLX_ORIGIN = "https://www.olx.pl";
const OLX_GRAPHQL_ENDPOINT = `${OLX_ORIGIN}/apigateway/graphql`;
const OLX_OFFERS_ROUTE = "/api/v1/offers";
const MAX_PAGES_PER_PROFILE = 20;
const PAGE_SIZE = 40;
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_HOST_INTERVAL_MS = 2_500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 500;

export const OLX_POLICY_SOURCES = {
  faq: "https://developer.olx.pl/articles/faq",
  apiDoc: "https://developer.olx.pl/api/doc",
  robots: "https://www.olx.pl/robots.txt",
  currentTerms: "https://pomoc.olx.pl/olxplhelp/s/article/aktualny-regulamin-V32-olx",
  termsArchive: "https://pomoc.olx.pl/olxplhelp/s/topic/0TO09000000kfhvGAA/archiwum-zmian-regulaminu",
} as const;

type RecordValue = Record<string, unknown>;
type ScrapeErrorKind = FetchBatch["errors"][number]["kind"];
type SearchParameters = {
  categoryId: number;
  regionId: number;
  cityId: number;
  query: string;
  suggestFilters: string;
  sl?: string;
};
type PageResult = {
  records: unknown[];
  totalElements: number | null;
  nextOffset: number | null;
};

export type OlxAdapterOptions = {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  minHostIntervalMs?: number;
  now?: () => Date;
};

const LISTING_SEARCH_QUERY = `
query ListingSearchQuery($searchParameters: [SearchParameter!] = [], $searchOptions: SearchOptions) {
  clientCompatibleListings(searchParameters: $searchParameters, searchOptions: $searchOptions) {
    __typename
    ... on ListingSuccess {
      data {
        id
        title
        url
        created_time
        location {
          city { name }
          district { name }
        }
        params {
          key
          value {
            __typename
            ... on PriceParam {
              value
              currency
              arranged
              budget
            }
            ... on GenericParam {
              label
            }
          }
        }
      }
      metadata { total_elements }
      links { next { href } }
    }
  }
}`;

class OlxRequestError extends Error {
  constructor(readonly kind: ScrapeErrorKind, readonly status?: number) {
    super("OLX request failed");
    this.name = "OlxRequestError";
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

function asPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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

function roomCount(value: unknown): number | null {
  const text = asText(value);
  if (!text) return null;
  const match = text.match(/^(\d{1,2})(?:\s|$)/);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function listingUrl(value: unknown): string | null {
  const raw = asText(value);
  if (!raw) return null;

  try {
    const url = new URL(raw, OLX_ORIGIN);
    const hostname = url.hostname.toLowerCase();
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.username
      || url.password
      || !["www.olx.pl", "olx.pl"].includes(hostname)
      || !/^\/(?:d\/)?oferta\//i.test(url.pathname)
    ) return null;

    url.protocol = "https:";
    url.hostname = "www.olx.pl";
    url.search = "";
    url.hash = "";
    return canonicalizeListingUrl(SOURCE, url.toString());
  } catch {
    return null;
  }
}

function listingParameters(item: RecordValue): {
  pricePln: number | null;
  areaM2: number | null;
  rooms: number | null;
  floor: number | null;
} {
  let pricePln: number | null = null;
  let areaM2: number | null = null;
  let rooms: number | null = null;
  let floor: number | null = null;
  const params = Array.isArray(item.params) ? item.params : [];

  for (const entryValue of params) {
    const entry = asRecord(entryValue);
    const key = asText(entry?.key);
    const value = asRecord(entry?.value);
    if (!key || !value) continue;

    const label = asText(value.label);
    if (key === "price") {
      const currency = asText(value.currency)?.toUpperCase();
      if (currency === "PLN" && value.arranged !== true && value.budget !== true) {
        pricePln = parsePricePln(asText(value.value) ?? (typeof value.value === "number" ? value.value : null));
      }
    } else if (key === "m") {
      areaM2 = parseAreaM2(label);
    } else if (key === "rooms") {
      rooms = roomCount(label);
    } else if (key === "floor_select") {
      floor = floorNumber(label);
    }
  }

  return { pricePln, areaM2, rooms, floor };
}

function mapListing(itemValue: unknown, capturedAt: string): NormalizedListing | null {
  const item = asRecord(itemValue);
  if (!item) return null;

  const canonicalUrl = listingUrl(item.url);
  if (!canonicalUrl) return null;
  const externalId = stableExternalId(SOURCE, canonicalUrl, asText(item.id));
  const location = asRecord(item.location);
  const city = asText(asRecord(location?.city)?.name);
  const district = asText(asRecord(location?.district)?.name);
  const values = listingParameters(item);
  const parsed = NormalizedListingSchema.safeParse({
    source: SOURCE,
    externalId,
    canonicalUrl,
    title: shortTitle(item.title),
    transaction: "sale",
    category: "apartment",
    market: "unknown",
    ...values,
    city: city?.slice(0, 160) ?? null,
    district: district?.slice(0, 160) ?? null,
    street: null,
    latitude: null,
    longitude: null,
    publishedAt: dateToIso(item.created_time),
    promotedAt: null,
    imageOriginalUrl: null,
    imageAlt: null,
    propertyFeatures: [],
    sourceEvidence: "browser",
    capturedAt,
  });

  return parsed.success ? parsed.data : null;
}

function missingFields(itemValue: unknown): string[] {
  const item = asRecord(itemValue);
  if (!item) return [];

  const location = asRecord(item.location);
  const city = asText(asRecord(location?.city)?.name);
  const district = asText(asRecord(location?.district)?.name);
  const values = listingParameters(item);
  const fields: Array<[string, boolean]> = [
    ["missing_source_id", !asText(item.id)],
    ["missing_title", !shortTitle(item.title)],
    ["missing_price_pln", values.pricePln === null],
    ["missing_area_m2", values.areaM2 === null],
    ["missing_rooms", values.rooms === null],
    ["missing_floor", values.floor === null],
    ["missing_city", !city],
    ["missing_district", !district],
    ["missing_published_at", !dateToIso(item.created_time)],
  ];

  const rawUrl = asText(item.url);
  if (!rawUrl) fields.push(["missing_source_url", true]);
  else if (!listingUrl(rawUrl)) fields.push(["invalid_source_url", true]);

  return fields.filter(([, isMissing]) => isMissing).map(([key]) => key);
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function missingFieldsWarning(counts: Record<string, number>): string | null {
  const missing = Object.entries(counts)
    .filter(([key, count]) => key.startsWith("missing_") && count > 0)
    .map(([key, count]) => `${key.slice("missing_".length)}=${count}`);
  return missing.length > 0 ? `Braki pól w pobranych rekordach: ${missing.join(", ")}.` : null;
}

function uniqueSearchValue(url: URL, key: string): { ok: boolean; value?: string } {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) return { ok: false };
  return { ok: true, value: values[0]?.trim() };
}

function configuredSearchValue(value: unknown, fallback: string | undefined, maxLength: number):
  | { ok: true; value?: string }
  | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  const text = typeof value === "string"
    ? value.trim()
    : typeof value === "boolean"
      ? String(value)
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : null;
  if (text === null || text.length > maxLength) return { ok: false };
  return { ok: true, value: text };
}

function parseOlxSearchUrl(profile: SearchProfile):
  | { kind: "ok"; parameters: SearchParameters }
  | { kind: "invalid-url" }
  | { kind: "missing-ids" } {
  const input = profile.olxSearchUrl;
  if (!input) return { kind: "invalid-url" };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: "invalid-url" };
  }

  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "www.olx.pl"
    || url.username
    || url.password
    || !url.pathname.startsWith("/nieruchomosci/")
  ) return { kind: "invalid-url" };

  const categoryValue = uniqueSearchValue(url, "category_id");
  const regionValue = uniqueSearchValue(url, "region_id");
  const cityValue = uniqueSearchValue(url, "city_id");
  if (!categoryValue.ok || !regionValue.ok || !cityValue.ok) return { kind: "invalid-url" };

  const configured = profile.olxSearchParams;
  const categoryId = asPositiveInteger(configured?.categoryId ?? categoryValue.value);
  const regionId = asPositiveInteger(configured?.regionId ?? regionValue.value);
  const cityId = asPositiveInteger(configured?.cityId ?? cityValue.value);
  if (!categoryId || !regionId || !cityId) return { kind: "missing-ids" };

  const query = uniqueSearchValue(url, "query");
  const sl = uniqueSearchValue(url, "sl");
  const suggestFilters = uniqueSearchValue(url, "suggest_filters");
  if (!query.ok || !sl.ok || !suggestFilters.ok) return { kind: "invalid-url" };

  const configuredQuery = configuredSearchValue(configured?.query, query.value, 200);
  const configuredSl = configuredSearchValue(configured?.sl, sl.value, 120);
  const configuredSuggestFilters = configuredSearchValue(
    configured?.suggestFilters,
    suggestFilters.value,
    40,
  );
  if (!configuredQuery.ok || !configuredSl.ok || !configuredSuggestFilters.ok) {
    return { kind: "invalid-url" };
  }

  return {
    kind: "ok",
    parameters: {
      categoryId,
      regionId,
      cityId,
      query: configuredQuery.value ?? "",
      suggestFilters: configuredSuggestFilters.value ?? "true",
      ...(configuredSl.value ? { sl: configuredSl.value } : {}),
    },
  };
}

function searchParameterPairs(parameters: SearchParameters, offset: number): Array<{ key: string; value: string }> {
  return [
    { key: "offset", value: String(offset) },
    { key: "limit", value: String(PAGE_SIZE) },
    { key: "query", value: parameters.query },
    { key: "category_id", value: String(parameters.categoryId) },
    { key: "region_id", value: String(parameters.regionId) },
    { key: "city_id", value: String(parameters.cityId) },
    { key: "suggest_filters", value: parameters.suggestFilters },
    ...(parameters.sl ? [{ key: "sl", value: parameters.sl }] : []),
  ];
}

function nextOffsetFromHref(href: string, currentOffset: number): number | null {
  try {
    const url = new URL(href, OLX_ORIGIN);
    if (
      url.protocol !== "https:"
      || url.hostname !== "www.olx.pl"
      || url.username
      || url.password
      || url.pathname !== OLX_OFFERS_ROUTE
    ) return null;

    const offset = asNonNegativeInteger(url.searchParams.get("offset"));
    const limit = asPositiveInteger(url.searchParams.get("limit"));
    if (
      offset === null
      || limit !== PAGE_SIZE
      || offset <= currentOffset
      || offset > currentOffset + PAGE_SIZE * 2
    ) return null;
    return offset;
  } catch {
    return null;
  }
}

function parseGraphqlPage(body: string, currentOffset: number): PageResult {
  let rootValue: unknown;
  try {
    rootValue = JSON.parse(body);
  } catch {
    throw new OlxRequestError("PARSE_CHANGED");
  }

  const root = asRecord(rootValue);
  if (Array.isArray(root?.errors) && root.errors.length > 0) {
    throw new OlxRequestError("PARSE_CHANGED");
  }

  const data = asRecord(root?.data);
  const result = asRecord(data?.clientCompatibleListings);
  if (!Array.isArray(result?.data)) throw new OlxRequestError("PARSE_CHANGED");

  const metadata = asRecord(result.metadata);
  const totalElements = asNonNegativeInteger(metadata?.total_elements);
  const links = asRecord(result.links);
  if (!links || !Object.prototype.hasOwnProperty.call(links, "next")) {
    throw new OlxRequestError("PARSE_CHANGED");
  }

  const nextValue = links.next;
  if (nextValue === null) return { records: result.data, totalElements, nextOffset: null };
  const next = asRecord(nextValue);
  if (!next) throw new OlxRequestError("PARSE_CHANGED");
  if (next.href === null) return { records: result.data, totalElements, nextOffset: null };
  const href = asText(next.href);
  if (!href) throw new OlxRequestError("PARSE_CHANGED");
  const nextOffset = nextOffsetFromHref(href, currentOffset);
  if (nextOffset === null) throw new OlxRequestError("PARSE_CHANGED");

  return { records: result.data, totalElements, nextOffset };
}

function hasCaptchaChallenge(body: string): boolean {
  const normalized = body.toLocaleLowerCase("pl-PL").replace(/\s+/g, " ");
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
      return `OLX odmówił dostępu${status ? ` (HTTP ${status})` : ""}; przerwano źródło.`;
    case "CAPTCHA":
      return "OLX zwrócił stronę weryfikacyjną; przerwano bez obchodzenia zabezpieczeń.";
    case "RATE_LIMITED":
      return "OLX ograniczył częstotliwość żądań (HTTP 429); nie ponawiano.";
    case "TIMEOUT":
      return "Odczyt wyników OLX przekroczył limit czasu.";
    case "PARSE_CHANGED":
      return "OLX nie zwrócił rozpoznanej struktury ListingSearchQuery; parser wymaga aktualizacji.";
    case "EMPTY_CONFIRMED":
      return "OLX zwrócił poprawną listę bez ofert dla tego wyszukiwania.";
    case "UNSUPPORTED":
      return "Profil wymaga HTTPS URL wyników nieruchomości na www.olx.pl oraz jawnych categoryId, regionId i cityId w olxSearchParams lub query URL.";
    case "NETWORK":
      return "Nie udało się pobrać publicznych wyników OLX.";
    default:
      return "Wystąpił błąd adaptera OLX.";
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

function sourceHealthForError(kind: ScrapeErrorKind): SourceAccessStatus {
  if (["ACCESS_DENIED", "CAPTCHA", "RATE_LIMITED", "POLICY_BLOCKED"].includes(kind)) {
    return "BLOCKED_BY_ACCESS_OR_POLICY";
  }
  if (kind === "UNSUPPORTED") return "NOT_TESTED";
  return "FAILED";
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

async function readBoundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ResponseTooLargeError();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function requestPage(
  fetchImpl: typeof fetch,
  parameters: SearchParameters,
  offset: number,
  requestTimeoutMs: number,
  signal?: AbortSignal,
): Promise<PageResult> {
  if (signal?.aborted) throw new OlxRequestError("TIMEOUT");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchImpl(OLX_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: LISTING_SEARCH_QUERY,
        variables: {
          searchParameters: searchParameterPairs(parameters, offset),
          searchOptions: null,
        },
      }),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });

    const kind = httpErrorKind(response.status);
    if (kind) {
      await response.body?.cancel();
      throw new OlxRequestError(kind, response.status);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OlxRequestError("NETWORK", response.status);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(contentType.trim())) {
      const body = await readBoundedText(response);
      if (hasCaptchaChallenge(body)) throw new OlxRequestError("CAPTCHA", response.status);
      throw new OlxRequestError("UNSUPPORTED", response.status);
    }

    const body = await readBoundedText(response);
    if (hasCaptchaChallenge(body)) throw new OlxRequestError("CAPTCHA", response.status);
    return parseGraphqlPage(body, offset);
  } catch (error) {
    if (error instanceof OlxRequestError || error instanceof ResponseTooLargeError) throw error;
    if (signal?.aborted || timedOut) throw new OlxRequestError("TIMEOUT");
    throw new OlxRequestError("NETWORK");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export class OlxSourceAdapter implements SourceAdapter {
  readonly source = SOURCE;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly minHostIntervalMs: number;
  private readonly now: () => Date;
  private lastHealthStatus: SourceAccessStatus = "NOT_TESTED";
  private lastHealthDiagnostic = "Brak jeszcze odczytu wyników OLX.";

  constructor(options: OlxAdapterOptions = {}) {
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
    const pageBudget = Math.min(
      Number.isFinite(options.maxPages) ? Math.max(0, Math.floor(options.maxPages)) : 1,
      MAX_PAGES_PER_PROFILE,
    );
    if (pageBudget === 0) {
      this.lastHealthStatus = "NOT_TESTED";
      this.lastHealthDiagnostic = "Nie wysłano żądania: budżet stron wynosi 0.";
      return batch(profile, {
        listings: [], inspectedPages: 0, requestCount: 0, isFullTraversal: false,
        sourceIsReachable: false, warnings: [this.lastHealthDiagnostic], errors: [],
      });
    }

    if (!profile.olxSearchUrl) {
      this.lastHealthStatus = "NOT_TESTED";
      this.lastHealthDiagnostic = errorMessage("UNSUPPORTED");
      return errorBatch(profile, "UNSUPPORTED", 0, 0, false);
    }

    const parsedSearch = parseOlxSearchUrl(profile);
    if (parsedSearch.kind !== "ok") {
      const message = parsedSearch.kind === "missing-ids"
        ? "Profil nie zawiera jawnych categoryId, regionId i cityId w olxSearchParams ani query URL; adapter nie wylicza ich z nazw lokalizacji."
        : errorMessage("UNSUPPORTED");
      this.lastHealthStatus = "NOT_TESTED";
      this.lastHealthDiagnostic = message;
      return batch(profile, {
        listings: [], inspectedPages: 0, requestCount: 0, isFullTraversal: false,
        sourceIsReachable: false, warnings: [],
        errors: [{ kind: "UNSUPPORTED", message }],
      });
    }

    const listings = new Map<string, NormalizedListing>();
    const warnings: string[] = [];
    const skippedCounts: Record<string, number> = {};
    let requestCount = 0;
    let inspectedPages = 0;
    let inspectedRecords = 0;
    let offset = 0;
    let totalElements: number | null = null;
    let traversalComplete = false;

    for (let page = 1; page <= pageBudget; page += 1) {
      if (options.signal?.aborted) {
        const kind: ScrapeErrorKind = "TIMEOUT";
        warnings.push(`Import jest niepełny: przerwano po ${inspectedPages} stronach.`);
        this.lastHealthStatus = sourceHealthForError(kind);
        this.lastHealthDiagnostic = errorMessage(kind);
        return batch(profile, {
          listings: [...listings.values()], inspectedPages, requestCount, isFullTraversal: false,
          sourceIsReachable: inspectedPages > 0, warnings,
          skippedCounts,
          errors: [{ kind, message: errorMessage(kind) }],
        });
      }

      let result: PageResult;
      try {
        result = await withHostRateLimit(
          options.signal,
          () => {
            requestCount += 1;
            return requestPage(
              this.fetchImpl,
              parsedSearch.parameters,
              offset,
              this.requestTimeoutMs,
              options.signal,
            );
          },
          this.minHostIntervalMs,
        );
      } catch (error) {
        const kind = error instanceof OlxRequestError
          ? error.kind
          : error instanceof ResponseTooLargeError ? "UNSUPPORTED"
            : options.signal?.aborted ? "TIMEOUT" : "NETWORK";
        const status = error instanceof OlxRequestError ? error.status : undefined;
        warnings.push(`Import jest niepełny: przerwano po ${inspectedPages} stronach.`);
        this.lastHealthStatus = sourceHealthForError(kind);
        this.lastHealthDiagnostic = errorMessage(kind, status);
        return batch(profile, {
          listings: [...listings.values()], inspectedPages, requestCount, isFullTraversal: false,
          sourceIsReachable: inspectedPages > 0 || status !== undefined,
          warnings,
          skippedCounts,
          errors: [{ kind, message: errorMessage(kind, status) }],
        });
      }

      inspectedPages += 1;
      totalElements = result.totalElements ?? totalElements;
      let addedOnPage = 0;
      for (const record of result.records) {
        inspectedRecords += 1;
        const row = asRecord(record);
        if (!row) incrementCount(skippedCounts, "malformed_record");
        for (const field of missingFields(record)) incrementCount(skippedCounts, field);
        const listing = mapListing(record, this.now().toISOString());
        if (!listing) {
          incrementCount(skippedCounts, "invalid_record");
          continue;
        }
        if (listings.has(listing.externalId)) {
          incrementCount(skippedCounts, "duplicate_record");
          continue;
        }
        listings.set(listing.externalId, listing);
        addedOnPage += 1;
      }

      if (result.records.length > 0 && addedOnPage === 0) {
        warnings.push(`Strona ${page} zawierała wyłącznie nieobsługiwane lub powtórzone rekordy; przerwano paginację.`);
        break;
      }

      if (result.nextOffset === null) {
        traversalComplete = true;
        if (page === 1 && listings.size === 0 && totalElements === 0) {
          this.lastHealthStatus = "LIVE_PARTIAL";
          this.lastHealthDiagnostic = errorMessage("EMPTY_CONFIRMED");
          return batch(profile, {
            listings: [], inspectedPages, requestCount, isFullTraversal: true,
            sourceIsReachable: true, warnings, skippedCounts,
            errors: [{ kind: "EMPTY_CONFIRMED", message: errorMessage("EMPTY_CONFIRMED") }],
          });
        }
        break;
      }

      if (result.records.length === 0) {
        warnings.push(`Strona ${page} była pusta mimo dalszego linku paginacji; przerwano.`);
        break;
      }
      offset = result.nextOffset;
    }

    if (totalElements !== null && listings.size < totalElements) {
      warnings.push(`OLX podał ${totalElements} łącznych wyników i ${listings.size} unikalnych ofert w pobranych stronach.`);
    }
    const fieldsWarning = missingFieldsWarning(skippedCounts);
    if (fieldsWarning) warnings.push(fieldsWarning);
    if (!traversalComplete && inspectedPages >= pageBudget) {
      warnings.push(`Import jest niepełny: pobrano ${inspectedPages} z ${pageBudget} stron dozwolonych przez bieżący budżet synchronizacji.`);
    }

    this.lastHealthStatus = "LIVE_PARTIAL";
    this.lastHealthDiagnostic = `Odczytano ${listings.size} unikalnych ofert z ${inspectedRecords} rekordów na ${inspectedPages} stronach; DB/UI niezweryfikowane.`;
    return batch(profile, {
      listings: [...listings.values()],
      inspectedPages,
      requestCount,
      isFullTraversal: traversalComplete,
      sourceIsReachable: inspectedPages > 0,
      warnings,
      skippedCounts,
      errors: [],
    });
  }

  async healthcheck(): Promise<{ status: SourceAccessStatus; diagnostic?: string }> {
    return { status: this.lastHealthStatus, diagnostic: this.lastHealthDiagnostic };
  }
}
