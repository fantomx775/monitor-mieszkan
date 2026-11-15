import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import {
  FetchBatchSchema,
  NormalizedListingSchema,
  type FetchBatch,
  type NormalizedListing,
  type SearchProfile,
  type SourceAccessStatus,
  type SourceAdapter,
  type SourceKey,
} from "./contracts";
import {
  canonicalizeListingUrl,
  parseAreaM2,
  parsePricePln,
  parseRoomCount,
  stableExternalId,
} from "./normalization";

type PortalKey = Exclude<SourceKey, "otodom" | "olx" | "morizon" | "gratka" | "domy" | "domiporta" | "adresowo" | "manual">;

export type HtmlListPortalConfig = {
  source: PortalKey;
  name: string;
  host: string;
  buildSearchUrl(city: string): string;
  linkSelector: string;
  cardSelector?: string;
  matchesListingPath(url: URL, searchUrl: URL): boolean;
  priceSelectors?: string[];
  areaSelectors?: string[];
  roomSelectors?: string[];
  market?: NormalizedListing["market"];
  externalId?(card: Cheerio<AnyNode>, url: URL): string | null;
};

type AdapterOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
  maxHtmlBytes?: number;
};

type PortalError = FetchBatch["errors"][number]["kind"];

const REQUEST_TIMEOUT_MS = 15_000;
const MIN_HOST_INTERVAL_MS = 2_500;
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const lastHostRequestAt = new Map<string, number>();

function abortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

async function waitForHostInterval(host: string, signal: AbortSignal): Promise<void> {
  const remaining = (lastHostRequestAt.get(host) ?? 0) + MIN_HOST_INTERVAL_MS - Date.now();
  if (remaining <= 0) return;
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, remaining);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  if (signal.aborted) throw abortError();
  lastHostRequestAt.set(host, Date.now());
}

function citySlug(city: string): string {
  const value = city
    .trim()
    .replace(/[łŁ]/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!value) throw new Error("Profil wyszukiwania wymaga poprawnej nazwy miasta.");
  return value;
}

function allowedHost(hostname: string, domain: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./, "");
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

function makeBatch(
  source: PortalKey,
  profile: SearchProfile,
  input: Omit<FetchBatch, "source" | "profileId">,
): FetchBatch {
  return FetchBatchSchema.parse({ source, profileId: profile.id, ...input });
}

function errorBatch(
  config: HtmlListPortalConfig,
  profile: SearchProfile,
  url: string,
  kind: PortalError,
  diagnostic: string,
  requestCount: number,
  reachable: boolean,
): FetchBatch {
  return makeBatch(config.source, profile, {
    listings: [],
    inspectedPages: requestCount ? 1 : 0,
    requestCount,
    isFullTraversal: false,
    sourceIsReachable: reachable,
    warnings: [],
    errors: [{ kind, message: `${config.name}: ${diagnostic}`, url }],
  });
}

function errorFromStatus(status: number): PortalError | null {
  if (status === 401 || status === 403) return "ACCESS_DENIED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status >= 400) return "NETWORK";
  return null;
}

function hasCaptchaChallenge(content: string): boolean {
  const normalized = content.toLocaleLowerCase("pl-PL").replace(/\s+/g, " ");
  return [
    "captcha",
    "datadome",
    "cf-chl-",
    "verify you are human",
    "checking your browser",
    "robot check",
    "potwierdź, że nie jesteś robotem",
    "sprawdź, czy jesteś człowiekiem",
    "wykryliśmy nietypowy ruch",
  ].some((marker) => normalized.includes(marker));
}

function confirmsEmptySearch(text: string): boolean {
  const normalized = text.toLocaleLowerCase("pl-PL");
  return [
    "nie znaleźliśmy żadnych ofert",
    "nie znaleziono ofert",
    "nie znaleźliśmy wyników",
    "nie znaleziono wyników",
    "brak ofert spełniających kryteria",
    "nie ma ofert spełniających kryteria",
  ].some((marker) => normalized.includes(marker));
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
      throw new Error("response size limit");
    }
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

function leafTexts($: CheerioAPI, card: Cheerio<AnyNode>): string[] {
  const values: string[] = [];
  card.find("*").each((_index, element) => {
    const current = $(element);
    if (current.children().length > 0) return;
    const text = current.text().replace(/\s+/g, " ").trim();
    if (text && text.length <= 180) values.push(text);
  });
  return values;
}

function fieldValues(
  $: CheerioAPI,
  card: Cheerio<AnyNode>,
  selectors: string[] | undefined,
): string[] {
  const values: string[] = [];
  for (const selector of selectors ?? []) {
    card.find(selector).each((_index, element) => {
      const current = $(element);
      const value = current.attr("content")
        ?? current.attr("data-price")
        ?? current.attr("data-area")
        ?? current.attr("data-rooms")
        ?? current.text();
      if (value?.trim()) values.push(value.trim());
    });
  }
  return values;
}

function parseRooms(values: string[]): number | null {
  for (const value of values) {
    const common = parseRoomCount(value);
    if (common !== null) return common;
    const propertyStyle = value.match(/\b(\d{1,2})[\s-]*pokoj(?:owe|owy|owego|owych)\b/i);
    if (propertyStyle) {
      const rooms = Number(propertyStyle[1]);
      if (Number.isSafeInteger(rooms) && rooms > 0) return rooms;
    }
    const labeled = value.match(/(?:liczba|ilość)\s+pokoi\s*:?\s*(\d{1,2})\b/i);
    if (labeled) {
      const rooms = Number(labeled[1]);
      if (Number.isSafeInteger(rooms) && rooms > 0) return rooms;
    }
  }
  return null;
}

function parseFields(
  $: CheerioAPI,
  card: Cheerio<AnyNode>,
  config: HtmlListPortalConfig,
): { pricePln: number | null; areaM2: number | null; rooms: number | null } {
  const leaves = leafTexts($, card);
  const compactText = card.text().replace(/\s+/g, " ").trim();
  const candidates = [...new Set([...leaves, compactText])];
  const priceValues = [...fieldValues($, card, config.priceSelectors), ...candidates]
    .filter((value) => /\d[\d\s.,]*\s*(?:zł|pln)(?![a-z])/i.test(value) || /^\s*\d[\d\s.,]*\s*$/.test(value));
  const areaValues = [...fieldValues($, card, config.areaSelectors), ...candidates]
    .filter((value) => /(?:m²|m2|metr)/i.test(value) || /^\s*\d{1,3}(?:[,.]\d{1,2})?\s*$/.test(value));
  const roomValues = [...fieldValues($, card, config.roomSelectors), ...candidates];
  const pricePln = priceValues
    .filter((value) => !/(?:\/|za\s*)\s*(?:m²|m2)/i.test(value))
    .map(parsePricePln)
    .find((value) => value !== null) ?? null;
  const areaM2 = areaValues
    .filter((value) => !/zł\s*\/\s*(?:m²|m2)/i.test(value))
    .map(parseAreaM2)
    .find((value) => value !== null) ?? null;
  const rooms = parseRooms(roomValues);
  return { pricePln, areaM2, rooms };
}

function listingUrlsIn(
  $: CheerioAPI,
  container: Cheerio<AnyNode>,
  config: HtmlListPortalConfig,
  searchUrl: URL,
): Set<string> {
  const urls = new Set<string>();
  const anchors: AnyNode[] = [];
  if (container.is("a[href]")) {
    container.each((_index, element) => { anchors.push(element); });
  }
  container.find("a[href]").each((_index, element) => { anchors.push(element); });
  for (const element of anchors) {
    const href = $(element).attr("href");
    if (!href) continue;
    try {
      const url = new URL(href, searchUrl);
      if (!allowedHost(url.hostname, config.host) || !config.matchesListingPath(url, searchUrl)) continue;
      urls.add(canonicalizeListingUrl(config.source, url.toString()));
    } catch {
      // Ignore malformed or off-domain links inside a public result card.
    }
  }
  return urls;
}

function findCard(
  $: CheerioAPI,
  anchor: Cheerio<AnyNode>,
  config: HtmlListPortalConfig,
  searchUrl: URL,
): Cheerio<AnyNode> {
  if (config.cardSelector) {
    const explicit = anchor.closest(config.cardSelector);
    if (explicit.length) return explicit;
  }

  let current = anchor.parent();
  let best = current;
  let bestScore = -1;
  for (let depth = 0; depth < 9 && current.length; depth += 1) {
    const urls = listingUrlsIn($, current, config, searchUrl);
    if (urls.size > 1) break;
    if (urls.size === 1) {
      const fields = parseFields($, current, config);
      const score = [fields.pricePln, fields.areaM2, fields.rooms].filter((value) => value !== null).length;
      if (score > bestScore) {
        best = current;
        bestScore = score;
      }
      if (score === 3) break;
    }
    current = current.parent();
  }
  return best;
}

function titleForCard(
  $: CheerioAPI,
  card: Cheerio<AnyNode>,
  canonicalUrl: string,
  searchUrl: URL,
  config: HtmlListPortalConfig,
): string | null {
  const candidates: string[] = [];
  card.find("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    try {
      const target = new URL(href, searchUrl);
      if (!config.matchesListingPath(target, searchUrl)) return;
      if (canonicalizeListingUrl(config.source, target.toString()) !== canonicalUrl) return;
    } catch {
      return;
    }
    const title = $(element).attr("title")?.trim();
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (title) candidates.push(title);
    if (text) candidates.push(text);
  });
  const title = candidates.find((value) => value.length >= 4 && value.length <= 500 && !/^zobacz ofertę$/i.test(value));
  return title?.replace(/\s+/g, " ").trim().slice(0, 500) ?? null;
}

function idForCard(config: HtmlListPortalConfig, card: Cheerio<AnyNode>, url: URL, canonicalUrl: string): string {
  const supplied = config.externalId?.(card, url);
  if (supplied?.trim()) return supplied.trim().slice(0, 180);
  return stableExternalId(config.source, canonicalUrl);
}

function parsePage(html: string, profile: SearchProfile, config: HtmlListPortalConfig, capturedAt: string, searchUrl: URL):
  | { kind: "listings"; listings: NormalizedListing[] }
  | { kind: "empty" }
  | { kind: "changed" } {
  const $ = load(html);
  const pageText = ($("body").text() || $.root().text()).replace(/\s+/g, " ").trim();
  const records: NormalizedListing[] = [];
  const visited = new Set<string>();
  const visitedCards = new Set<AnyNode>();

  $(config.linkSelector).each((_index, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");
    if (!href) return;
    let url: URL;
    let canonicalUrl: string;
    try {
      url = new URL(href, searchUrl);
      if (!allowedHost(url.hostname, config.host) || !config.matchesListingPath(url, searchUrl)) return;
      canonicalUrl = canonicalizeListingUrl(config.source, url.toString());
    } catch {
      return;
    }
    if (canonicalUrl === canonicalizeListingUrl(config.source, searchUrl.toString()) || visited.has(canonicalUrl)) return;
    const card = findCard($, anchor, config, searchUrl);
    const cardNode = card.get(0);
    if (cardNode && visitedCards.has(cardNode)) return;
    if (cardNode) visitedCards.add(cardNode);
    visited.add(canonicalUrl);
    const fields = parseFields($, card, config);
    records.push(NormalizedListingSchema.parse({
      source: config.source,
      externalId: idForCard(config, card, url, canonicalUrl),
      canonicalUrl,
      title: titleForCard($, card, canonicalUrl, searchUrl, config),
      transaction: "sale",
      category: "apartment",
      market: config.market ?? "unknown",
      pricePln: fields.pricePln,
      areaM2: fields.areaM2,
      rooms: fields.rooms,
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
    }));
  });

  const listings = [...new Map(records.map((listing) => [listing.externalId, listing])).values()];
  if (listings.length) return { kind: "listings", listings };
  if (confirmsEmptySearch(pageText)) return { kind: "empty" };
  return { kind: "changed" };
}

function accessStatusForError(kind: PortalError): SourceAccessStatus {
  if (["ACCESS_DENIED", "CAPTCHA", "RATE_LIMITED", "POLICY_BLOCKED"].includes(kind)) return "BLOCKED_BY_ACCESS_OR_POLICY";
  if (kind === "EMPTY_CONFIRMED") return "LIVE_PARTIAL";
  if (["PARSE_CHANGED", "NETWORK", "TIMEOUT", "INTERNAL"].includes(kind)) return "FAILED";
  return "NOT_TESTED";
}

function messageForError(config: HtmlListPortalConfig, kind: PortalError, status?: number): string {
  switch (kind) {
    case "ACCESS_DENIED": return `${config.name} odmówił dostępu${status ? ` (HTTP ${status})` : ""}; przerwano bez ponawiania.`;
    case "CAPTCHA": return `${config.name} zwrócił stronę CAPTCHA/weryfikacji; przerwano bez obchodzenia zabezpieczeń.`;
    case "RATE_LIMITED": return `${config.name} ograniczył częstotliwość żądań (HTTP 429); nie ponawiano.`;
    case "TIMEOUT": return `Odczyt publicznej listy ${config.name} przekroczył limit czasu.`;
    case "EMPTY_CONFIRMED": return `${config.name} potwierdził brak wyników na publicznej liście.`;
    case "PARSE_CHANGED": return `Nie rozpoznano linków ofert w publicznej liście ${config.name}; wymagany ponowny przegląd struktury.`;
    case "NETWORK": return `Nie udało się pobrać publicznej listy ${config.name}.`;
    case "UNSUPPORTED": return `${config.name} zwrócił nieobsługiwany typ odpowiedzi lub przekroczył limit rozmiaru; przerwano.`;
    default: return `Wystąpił błąd adaptera ${config.name}.`;
  }
}

export function createHtmlListAdapter(config: HtmlListPortalConfig, options: AdapterOptions = {}): SourceAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxHtmlBytes = options.maxHtmlBytes ?? MAX_HTML_BYTES;
  let lastHealthStatus: SourceAccessStatus = "NOT_TESTED";
  let lastHealthDiagnostic = "Brak jeszcze próby pobrania publicznej listy.";

  return {
    source: config.source,
    async discover(profile: SearchProfile, discoverOptions): Promise<FetchBatch> {
      let url: URL;
      try {
        url = new URL(config.buildSearchUrl(profile.city));
        if (url.protocol !== "https:" || !allowedHost(url.hostname, config.host)) throw new Error("invalid portal URL");
      } catch {
        lastHealthStatus = "FAILED";
        lastHealthDiagnostic = "Nie można zbudować bezpiecznego adresu listy ofert dla profilu.";
        return errorBatch(config, profile, `https://${config.host}/`, "UNSUPPORTED", lastHealthDiagnostic, 0, false);
      }

      const maxPages = Number.isFinite(discoverOptions.maxPages) ? Math.max(0, Math.floor(discoverOptions.maxPages)) : 1;
      if (maxPages === 0) {
        lastHealthStatus = "NOT_TESTED";
        lastHealthDiagnostic = "Nie wysłano żądania: budżet stron wynosi 0.";
        return makeBatch(config.source, profile, {
          listings: [], inspectedPages: 0, requestCount: 0, isFullTraversal: false,
          sourceIsReachable: false, warnings: [lastHealthDiagnostic], errors: [],
        });
      }

      let requestCount = 0;
      let response: Response;
      let html: string;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (discoverOptions.signal?.aborted) controller.abort();
      else discoverOptions.signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, requestTimeoutMs);
      try {
        if (controller.signal.aborted) throw abortError();
        await waitForHostInterval(config.host, controller.signal);
        requestCount += 1;
        lastHostRequestAt.set(config.host, Date.now());
        response = await fetchImpl(url.toString(), {
          method: "GET",
          credentials: "omit",
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml;q=0.9",
            "accept-language": "pl-PL,pl;q=0.8",
            "user-agent": "RealtyWatch/0.1 (personal property-purchase search)",
          },
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          lastHealthStatus = "FAILED";
          lastHealthDiagnostic = "Lista przekierowała żądanie; nie podążono za przekierowaniem.";
          return errorBatch(config, profile, url.toString(), "NETWORK", lastHealthDiagnostic, requestCount, true);
        }
        const statusError = errorFromStatus(response.status);
        if (statusError) {
          const status = response.status;
          await response.body?.cancel();
          const diagnostic = messageForError(config, statusError, status);
          lastHealthStatus = accessStatusForError(statusError);
          lastHealthDiagnostic = diagnostic;
          return errorBatch(config, profile, url.toString(), statusError, diagnostic, requestCount, true);
        }
        if (!response.ok || !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get("content-type") ?? "")) {
          await response.body?.cancel();
          const diagnostic = messageForError(config, "UNSUPPORTED");
          lastHealthStatus = "FAILED";
          lastHealthDiagnostic = diagnostic;
          return errorBatch(config, profile, url.toString(), "UNSUPPORTED", diagnostic, requestCount, true);
        }
        html = await readHtml(response, maxHtmlBytes);
      } catch (error) {
        const kind: PortalError = timedOut || discoverOptions.signal?.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
          ? "TIMEOUT"
          : error instanceof Error && error.message === "response size limit" ? "UNSUPPORTED" : "NETWORK";
        const diagnostic = messageForError(config, kind);
        lastHealthStatus = accessStatusForError(kind);
        lastHealthDiagnostic = diagnostic;
        return errorBatch(config, profile, url.toString(), kind, diagnostic, requestCount, false);
      } finally {
        clearTimeout(timer);
        discoverOptions.signal?.removeEventListener("abort", onAbort);
      }

      if (hasCaptchaChallenge(html)) {
        const diagnostic = messageForError(config, "CAPTCHA");
        lastHealthStatus = "BLOCKED_BY_ACCESS_OR_POLICY";
        lastHealthDiagnostic = diagnostic;
        return errorBatch(config, profile, url.toString(), "CAPTCHA", diagnostic, requestCount, true);
      }

      const parsed = parsePage(html, profile, config, now().toISOString(), url);
      if (parsed.kind === "empty") {
        const diagnostic = messageForError(config, "EMPTY_CONFIRMED");
        lastHealthStatus = "LIVE_PARTIAL";
        lastHealthDiagnostic = diagnostic;
        return errorBatch(config, profile, url.toString(), "EMPTY_CONFIRMED", diagnostic, requestCount, true);
      }
      if (parsed.kind === "changed") {
        const diagnostic = messageForError(config, "PARSE_CHANGED");
        lastHealthStatus = "FAILED";
        lastHealthDiagnostic = diagnostic;
        return errorBatch(config, profile, url.toString(), "PARSE_CHANGED", diagnostic, requestCount, true);
      }

      const incompleteCount = parsed.listings.filter((listing) => listing.pricePln === null || listing.areaM2 === null).length;
      const warnings = [
        "Pobrano tylko pierwszą stronę listy; pełne pokrycie portalu nie zostało sprawdzone.",
        ...(incompleteCount > 0 ? [`W ${incompleteCount} z ${parsed.listings.length} rekordów cena lub metraż nie były widoczne na liście i pozostały puste.`] : []),
      ];
      lastHealthStatus = "LIVE_PARTIAL";
      lastHealthDiagnostic = `Publiczna lista sparsowana; baza i widok UI niezweryfikowane (${parsed.listings.length} rekordów).`;
      return makeBatch(config.source, profile, {
        listings: parsed.listings,
        inspectedPages: 1,
        requestCount,
        isFullTraversal: false,
        sourceIsReachable: true,
        warnings,
        errors: [],
      });
    },
    async healthcheck() {
      return { status: lastHealthStatus, diagnostic: lastHealthDiagnostic };
    },
  };
}

export function portalCitySlug(city: string): string {
  return citySlug(city);
}
