import { XMLParser, XMLValidator } from "fast-xml-parser";

import type {
  FetchBatch,
  NormalizedListing,
  SearchProfile,
  SourceAdapter,
} from "../contracts";
import { retryTransient } from "../retry";
import {
  canonicalizeListingUrl,
  parseAreaM2,
  parsePricePln,
  parseRoomCount,
  stableExternalId,
} from "../normalization";

const SOURCE = "domy" as const;
const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_LENGTH = 180;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_DISCOVERY_DURATION_MS = 30_000;
const MIN_REQUEST_GAP_MS = 1_500;
const REQUEST_JITTER_MS = 400;

const CITY_FEEDS: Record<string, { city: string; url: string }> = {
  katowice: {
    city: "Katowice",
    url: "https://domy.pl/rss/mieszkania--katowice-pl",
  },
  gliwice: {
    city: "Gliwice",
    url: "https://domy.pl/rss/mieszkania--gliwice-pl",
  },
  krakow: {
    city: "Kraków",
    url: "https://domy.pl/rss/mieszkania--krakow-pl",
  },
};

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  textNodeName: "#text",
});

type XmlRecord = Record<string, unknown>;
type Scalar = string | number;
type ParsedFeed = Pick<FetchBatch, "listings" | "warnings" | "errors"> & { skippedCounts: Record<string, number> };
type FetchLike = typeof fetch;

function emptyBatch(profile: SearchProfile, fields: Partial<FetchBatch> = {}): FetchBatch {
  return {
    source: SOURCE,
    profileId: profile.id,
    listings: [],
    inspectedPages: 0,
    requestCount: fields.requestCount ?? fields.inspectedPages ?? 0,
    isFullTraversal: false,
    sourceIsReachable: false,
    warnings: [],
    skippedCounts: {},
    errors: [],
    ...fields,
  };
}

function normalizeCity(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pl-PL");
}

function normalizedXmlName(value: string): string {
  return value.split(":").at(-1)?.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "") ?? "";
}

function asRecord(value: unknown): XmlRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as XmlRecord)
    : null;
}

function child(record: unknown, wantedName: string): unknown {
  const object = asRecord(record);
  if (!object) return undefined;
  const wanted = normalizedXmlName(wantedName);
  const entry = Object.entries(object).find(([name]) => normalizedXmlName(name) === wanted);
  return entry?.[1];
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = scalarText(item);
      if (text) return text;
    }
    return null;
  }
  const object = asRecord(value);
  if (!object) return null;

  const directText = object["#text"] ?? object["#cdata"] ?? object["@_href"] ?? object.href;
  if (directText !== undefined) return scalarText(directText);
  for (const nested of Object.values(object)) {
    const text = scalarText(nested);
    if (text) return text;
  }
  return null;
}

function namedValues(value: unknown, names: ReadonlySet<string>): unknown[] {
  const found: unknown[] = [];
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    const object = asRecord(current);
    if (!object) return;
    for (const [key, nested] of Object.entries(object)) {
      if (names.has(normalizedXmlName(key))) found.push(nested);
      if (asRecord(nested) || Array.isArray(nested)) visit(nested);
    }
  };
  visit(value);
  return found;
}

function firstNamedText(record: unknown, names: readonly string[]): string | null {
  for (const name of names) {
    const text = scalarText(child(record, name));
    if (text) return text;
  }
  return null;
}

function toTransientText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortTitle(value: string | null): string | null {
  if (!value) return null;
  const normalized = toTransientText(value);
  if (!normalized || normalized.length > MAX_TITLE_LENGTH) return null;
  return normalized;
}

function parseExplicitPrice(value: Scalar): number | null {
  return parsePricePln(value);
}

function parsePriceFromText(values: readonly string[]): number | null {
  const currencyPattern = /(?<![\p{L}\p{N}])\d[\d\s\u00a0\u202f.,]*\s*(?:zł|pln)(?!\s*\/\s*(?:m²|m2))/iu;
  for (const value of values) {
    const match = toTransientText(value).match(currencyPattern);
    if (!match) continue;
    const parsed = parsePricePln(match[0]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseExplicitArea(value: Scalar): number | null {
  return parseAreaM2(value);
}

function parseAreaFromText(values: readonly string[]): number | null {
  const areaPattern = /\d[\d\s\u00a0\u202f.,]*\s*(?:m²|m2|metr(?:ów|y|a)?)/i;
  for (const value of values) {
    const match = toTransientText(value).match(areaPattern);
    if (!match) continue;
    const parsed = parseAreaM2(match[0]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseExplicitRooms(value: Scalar): number | null {
  if (typeof value === "number") return parseRoomCount(value);
  const text = value.trim();
  if (/^\d{1,2}$/.test(text)) return parseRoomCount(Number(text));
  return parseRoomCount(text);
}

function parseRoomsFromText(values: readonly string[]): number | null {
  for (const value of values) {
    const text = toTransientText(value);
    const match = text.match(/\b\d{1,2}\s*(?:pokoj(?:e|i|ów)?|p\.|rooms?)\b/i);
    if (match) {
      const parsed = parseRoomCount(match[0]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function validPublishedAt(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function getFeedItems(document: unknown): { recognized: boolean; items: unknown[] } {
  const root = asRecord(document);
  if (!root) return { recognized: false, items: [] };

  const rootValue = Object.entries(root).find(([name]) => !name.startsWith("?") && !name.startsWith("!"))?.[1];
  if (rootValue === undefined) return { recognized: false, items: [] };
  const rssRoot = child(rootValue, "rss") ?? rootValue;
  const channel = child(rssRoot, "channel");
  const rssItems = child(channel, "item");
  if (channel !== undefined) {
    return { recognized: true, items: rssItems === undefined ? [] : Array.isArray(rssItems) ? rssItems : [rssItems] };
  }

  const atomRoot = child(rootValue, "feed") ?? rootValue;
  const entries = child(atomRoot, "entry");
  if (entries !== undefined) {
    return { recognized: true, items: Array.isArray(entries) ? entries : [entries] };
  }

  return { recognized: false, items: [] };
}

function itemLink(item: unknown): string | null {
  const directLink = child(item, "link");
  if (typeof directLink === "string") return directLink;
  const atomHref = asRecord(directLink)?.["@_href"] ?? asRecord(directLink)?.href;
  return scalarText(atomHref) ?? scalarText(directLink);
}

function isConfirmedSaleApartment(url: string): boolean {
  const parsed = new URL(url);
  return /^\/mieszkanie\//i.test(parsed.pathname) && /-sba(?:\/|$)/i.test(parsed.pathname);
}

function listingFromItem(
  item: unknown,
  profile: SearchProfile,
  feedCity: string,
  capturedAt: string,
  skippedCounts: Record<string, number>,
): NormalizedListing | null {
  const rawLink = itemLink(item);
  if (!rawLink) {
    skippedCounts.missing_link = (skippedCounts.missing_link ?? 0) + 1;
    return null;
  }

  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeListingUrl(SOURCE, new URL(rawLink, "https://domy.pl").toString());
  } catch {
    skippedCounts.invalid_link = (skippedCounts.invalid_link ?? 0) + 1;
    return null;
  }
  if (!isConfirmedSaleApartment(canonicalUrl)) {
    skippedCounts.not_sale_apartment = (skippedCounts.not_sale_apartment ?? 0) + 1;
    return null;
  }

  const title = firstNamedText(item, ["title"]);
  const descriptionValues = namedValues(item, new Set(["description", "summary", "encoded"]));
  const descriptions = descriptionValues.map(scalarText).filter((value): value is string => Boolean(value));
  const titleText = title ? [title] : [];
  const textForNumericParse = [...titleText, ...descriptions];

  const priceFields = namedValues(item, new Set(["price", "pricepln", "totalprice", "cena"]));
  const areaFields = namedValues(item, new Set(["area", "aream2", "surface", "surfacearea", "powierzchnia", "m2"]));
  const roomFields = namedValues(item, new Set(["rooms", "roomscount", "numberofrooms", "pokoje"]));

  const explicitPrice = priceFields
    .map(scalarText)
    .filter((value): value is string => Boolean(value))
    .map(parseExplicitPrice)
    .find((value): value is number => value !== null);
  const explicitArea = areaFields
    .map(scalarText)
    .filter((value): value is string => Boolean(value))
    .map(parseExplicitArea)
    .find((value): value is number => value !== null);
  const explicitRooms = roomFields
    .map((value) => {
      const text = scalarText(value);
      return typeof value === "number" ? value : text;
    })
    .filter((value): value is Scalar => value !== null && value !== undefined)
    .map(parseExplicitRooms)
    .find((value): value is number => value !== null);

  return {
    source: SOURCE,
    externalId: stableExternalId(SOURCE, canonicalUrl),
    canonicalUrl,
    title: shortTitle(title),
    transaction: "sale",
    category: "apartment",
    market: "unknown",
    pricePln: explicitPrice ?? parsePriceFromText(textForNumericParse),
    areaM2: explicitArea ?? parseAreaFromText(textForNumericParse),
    rooms: explicitRooms ?? parseRoomsFromText(textForNumericParse),
    floor: null,
    city: feedCity || profile.city,
    district: null,
    street: null,
    latitude: null,
    longitude: null,
    publishedAt: validPublishedAt(
      firstNamedText(item, ["pubDate", "published", "date", "updated", "dc:date"]),
    ),
    promotedAt: null,
    imageOriginalUrl: null,
    imageAlt: null,
    propertyFeatures: [],
    sourceEvidence: "rss",
    capturedAt,
  };
}

/**
 * Parse only the small set of RSS facts retained by this adapter. Description
 * text is used transiently for labelled numeric values and is never returned.
 */
export function parseDomyRss(
  xml: string,
  profile: SearchProfile,
  capturedAt = new Date().toISOString(),
): ParsedFeed {
  const listings: NormalizedListing[] = [];
  const warnings: string[] = [];
  const errors: ParsedFeed["errors"] = [];
  const skippedCounts: Record<string, number> = {};

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    return {
      listings,
      warnings,
      skippedCounts,
      errors: [{ kind: "PARSE_CHANGED", message: "Odpowiedź kanału Domy.pl nie jest poprawnym XML RSS." }],
    };
  }

  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    return {
      listings,
      warnings,
      skippedCounts,
      errors: [{ kind: "PARSE_CHANGED", message: "Nie udało się odczytać struktury kanału Domy.pl." }],
    };
  }

  const { recognized, items } = getFeedItems(document);
  if (!recognized) {
    return {
      listings,
      warnings,
      skippedCounts,
      errors: [{ kind: "PARSE_CHANGED", message: "Struktura kanału Domy.pl uległa zmianie." }],
    };
  }
  if (items.length === 0) {
    return {
      listings,
      warnings,
      skippedCounts,
      errors: [{ kind: "EMPTY_CONFIRMED", message: "Potwierdzony kanał RSS nie zawiera wpisów." }],
    };
  }

  const city = CITY_FEEDS[normalizeCity(profile.city)]?.city ?? profile.city;
  const seen = new Set<string>();
  for (const item of items) {
    const listing = listingFromItem(item, profile, city, capturedAt, skippedCounts);
    if (!listing) {
      continue;
    }
    if (seen.has(listing.canonicalUrl)) {
      skippedCounts.duplicate_in_feed = (skippedCounts.duplicate_in_feed ?? 0) + 1;
      continue;
    }
    seen.add(listing.canonicalUrl);
    listings.push(listing);
  }

  const skipped = Object.values(skippedCounts).reduce((total, count) => total + count, 0);
  if (skipped > 0) {
    warnings.push(
      `Pominięto ${skipped} wpisów bez potwierdzonego linku do mieszkania na sprzedaż w domenie Domy.pl.`,
    );
  }
  return { listings, warnings, errors, skippedCounts };
}

function combineSignals(
  parent: AbortSignal | undefined,
  timeout: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!parent) return { signal: timeout, dispose: () => {} };
  const combined = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!combined.signal.aborted) combined.abort(signal.reason);
  };
  const abortParent = () => abortFrom(parent);
  const abortTimeout = () => abortFrom(timeout);
  if (parent.aborted) abortFrom(parent);
  else parent.addEventListener("abort", abortParent, { once: true });
  if (timeout.aborted) abortFrom(timeout);
  else timeout.addEventListener("abort", abortTimeout, { once: true });
  return {
    signal: combined.signal,
    dispose: () => {
      parent.removeEventListener("abort", abortParent);
      timeout.removeEventListener("abort", abortTimeout);
    },
  };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class DomainRequestGate {
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt = 0;

  async run<T>(
    operation: () => Promise<T>,
    options: { signal?: AbortSignal; minIntervalMs: number; jitterMs: number; random: () => number },
  ): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      if (this.lastStartedAt > 0) {
        const elapsed = Date.now() - this.lastStartedAt;
        const delay = Math.max(0, options.minIntervalMs - elapsed) +
          Math.floor(options.random() * (options.jitterMs + 1));
        await wait(delay, options.signal);
      }
      if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      this.lastStartedAt = Date.now();
      return await operation();
    } finally {
      release();
    }
  }
}

const domainRequestGate = new DomainRequestGate();

export function createDomyAdapter(options: {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  profileTimeoutMs?: number;
  minIntervalMs?: number;
  jitterMs?: number;
  random?: () => number;
} = {}): SourceAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const profileTimeoutMs = options.profileTimeoutMs ?? MAX_DISCOVERY_DURATION_MS;
  const minIntervalMs = options.minIntervalMs ?? MIN_REQUEST_GAP_MS;
  const jitterMs = options.jitterMs ?? REQUEST_JITTER_MS;
  const random = options.random ?? Math.random;
  return {
    source: SOURCE,

    async discover(profile, discoverOptions) {
      const feed = CITY_FEEDS[normalizeCity(profile.city)];
      if (!feed) {
        const message = normalizeCity(profile.city) === "tychy"
          ? "Kanał Domy.pl dla Tychów nie został zweryfikowany; źródło pozostaje nieobsługiwane."
          : "Zweryfikowane kanały Domy.pl obejmują wyłącznie Katowice, Gliwice i Kraków.";
        return emptyBatch(profile, { errors: [{ kind: "UNSUPPORTED", message }] });
      }
      if (discoverOptions.maxPages < 1) {
        return emptyBatch(profile, {
          warnings: ["Pobranie pominięto, ponieważ budżet maxPages wynosi zero."],
        });
      }

      const sourceTimeoutController = new AbortController();
      let sourceTimeoutElapsed = false;
      let requestCount = 0;
      const sourceTimeoutTimer = setTimeout(() => {
        sourceTimeoutElapsed = true;
        sourceTimeoutController.abort();
      }, profileTimeoutMs);
      const sourceSignal = combineSignals(discoverOptions.signal, sourceTimeoutController.signal);

      try {
        const { value: fetched } = await retryTransient(
          async () => {
            const attemptController = new AbortController();
            const attemptSignal = combineSignals(sourceSignal.signal, attemptController.signal);
            const attemptTimer = setTimeout(() => attemptController.abort(), timeoutMs);
            try {
              return await domainRequestGate.run(
                async () => {
                  requestCount += 1;
                  const response = await fetchImpl(feed.url, {
                    method: "GET",
                    headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9" },
                    redirect: "error",
                    cache: "no-store",
                    signal: attemptSignal.signal,
                  });
                  if (!response.ok) return { response, body: "", tooLarge: false };
                  const contentLength = Number(response.headers.get("content-length") ?? 0);
                  if (contentLength > MAX_FEED_BYTES) {
                    await response.body?.cancel();
                    return { response, body: "", tooLarge: true };
                  }
                  const body = await response.text();
                  const tooLarge = new TextEncoder().encode(body).byteLength > MAX_FEED_BYTES;
                  return { response, body: tooLarge ? "" : body, tooLarge };
                },
                { signal: attemptSignal.signal, minIntervalMs, jitterMs, random },
              );
            } finally {
              clearTimeout(attemptTimer);
              attemptSignal.dispose();
            }
          },
          {
            signal: sourceSignal.signal,
            shouldRetryValue: ({ response }) => response.status === 408 || response.status === 504 || response.status >= 500,
            shouldRetryError: (error) => !sourceSignal.signal.aborted && (
              error instanceof TypeError || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
            ),
            disposeValue: async ({ response }) => { await response.body?.cancel(); },
          },
        );
        const { response, body, tooLarge } = fetched;

        const base = { inspectedPages: requestCount > 0 ? 1 : 0, requestCount, isFullTraversal: false };
        if (!response.ok) await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          return emptyBatch(profile, {
            ...base,
            errors: [{ kind: "ACCESS_DENIED", message: `Domy.pl odmówiło dostępu do kanału (HTTP ${response.status}).`, url: feed.url }],
          });
        }
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after")?.replace(/[\r\n]/g, " ").trim().slice(0, 80);
          return emptyBatch(profile, {
            ...base,
            errors: [{ kind: "RATE_LIMITED", message: `Domy.pl ograniczyło tempo pobrań (HTTP 429); bez ponowienia w tym przebiegu.${retryAfter ? ` Retry-After: ${retryAfter}.` : ""}`, url: feed.url }],
          });
        }
        if (response.status === 451) {
          return emptyBatch(profile, {
            ...base,
            errors: [{ kind: "POLICY_BLOCKED", message: "Domy.pl zablokowało dostęp do kanału (HTTP 451).", url: feed.url }],
          });
        }
        if (response.status === 408 || response.status === 504) {
          return emptyBatch(profile, {
            ...base,
            errors: [{ kind: "TIMEOUT", message: `Przekroczono czas odpowiedzi Domy.pl (HTTP ${response.status}).`, url: feed.url }],
          });
        }
        if (!response.ok) {
          return emptyBatch(profile, {
            ...base,
            errors: [{ kind: "NETWORK", message: `Kanał Domy.pl zwrócił HTTP ${response.status}.`, url: feed.url }],
          });
        }

        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (contentType.includes("text/html") && /captcha|robot|verify you are human/i.test(body)) {
          return emptyBatch(profile, {
            ...base,
            sourceIsReachable: true,
            errors: [{ kind: "CAPTCHA", message: "Odpowiedź Domy.pl wymaga weryfikacji CAPTCHA; bez obchodzenia zabezpieczenia.", url: feed.url }],
          });
        }
        if (tooLarge) {
          return emptyBatch(profile, {
            ...base,
            sourceIsReachable: true,
            errors: [{ kind: "PARSE_CHANGED", message: "Kanał Domy.pl przekracza bezpieczny limit rozmiaru.", url: feed.url }],
          });
        }
        if (!body.trim()) {
          return emptyBatch(profile, {
            ...base,
            sourceIsReachable: true,
            errors: [{ kind: "PARSE_CHANGED", message: "Kanał Domy.pl zwrócił pustą odpowiedź.", url: feed.url }],
          });
        }

        const parsed = parseDomyRss(body, profile);
        return emptyBatch(profile, {
          ...base,
          ...parsed,
          sourceIsReachable: true,
          warnings: parsed.warnings,
          errors: parsed.errors.map((error) => ({ ...error, url: feed.url })),
        });
      } catch (error) {
        const base = { inspectedPages: requestCount > 0 ? 1 : 0, requestCount };
        if (sourceTimeoutElapsed) {
          return emptyBatch(profile, {
            ...base,
            errors: [{ kind: "TIMEOUT", message: "Przekroczono limit czasu pobierania kanału Domy.pl.", url: feed.url }],
          });
        }
        if (discoverOptions.signal?.aborted) {
          return emptyBatch(profile, {
            ...base,
            errors: [{ kind: "NETWORK", message: "Pobieranie kanału Domy.pl zostało anulowane.", url: feed.url }],
          });
        }
        const isAbort = error instanceof Error && error.name === "AbortError";
        return emptyBatch(profile, {
          ...base,
          errors: [{
            kind: isAbort ? "TIMEOUT" : "NETWORK",
            message: isAbort ? "Przekroczono limit czasu pobierania kanału Domy.pl." : "Nie udało się pobrać kanału Domy.pl.",
            url: feed.url,
          }],
        });
      } finally {
        clearTimeout(sourceTimeoutTimer);
        sourceSignal.dispose();
      }
    },

    async healthcheck() {
      return {
        status: "NOT_TESTED",
        diagnostic: "Healthcheck nie wykonuje żądania; dostępność sprawdza discover dla obsługiwanego profilu.",
      };
    },
  };
}

export const domyAdapter = createDomyAdapter();
