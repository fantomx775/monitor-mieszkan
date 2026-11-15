import { load } from "cheerio";

import { createHtmlListAdapter, portalCitySlug } from "../html-list-adapter";
import {
  FetchBatchSchema,
  type FetchBatch,
  type SearchProfile,
  type SourceAccessStatus,
  type SourceAdapter,
} from "../contracts";

const SOURCE = "nieruchomosci_online" as const;
const HOST = "nieruchomosci-online.pl";
const SEARCH_PATH = "/mieszkania,sprzedaz/";
const MAX_HTML_BYTES = 6 * 1024 * 1024;

type AdapterOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxHtmlBytes?: number;
};

type PaginationState = {
  known: boolean;
  nextPage: number | null;
};

function makeBatch(
  profile: SearchProfile,
  input: Omit<FetchBatch, "source" | "profileId">,
): FetchBatch {
  return FetchBatchSchema.parse({ source: SOURCE, profileId: profile.id, ...input });
}

function pageUrl(baseUrl: URL, page: number): URL {
  const url = new URL(baseUrl);
  if (page <= 1) url.searchParams.delete("p");
  else url.searchParams.set("p", String(page));
  return url;
}

async function readBoundedHtml(response: Response, maxBytes: number): Promise<string | null> {
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
      return null;
    }
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

function paginationState(html: string | null, currentUrl: URL, currentPage: number): PaginationState {
  if (!html) return { known: false, nextPage: null };

  const $ = load(html);
  const pages = new Set<number>();
  let known = false;

  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    try {
      const candidate = new URL(href, currentUrl);
      if (candidate.origin !== currentUrl.origin || candidate.pathname !== SEARCH_PATH) return;

      const rawPage = candidate.searchParams.get("p");
      if (!rawPage || !/^\d{1,4}$/.test(rawPage)) return;

      const number = Number(rawPage);
      if (!Number.isSafeInteger(number) || number < 1) return;
      known = true;
      if (number > currentPage) pages.add(number);
    } catch {
      // Ignore malformed or off-route links in portal navigation.
    }
  });

  const nextPage = [...pages].sort((left, right) => left - right)[0] ?? null;
  return { known, nextPage };
}

function missingFieldWarning(listings: FetchBatch["listings"]): string | null {
  if (listings.length === 0) return null;

  const missing = [
    ["tytuł", listings.filter((listing) => listing.title === null).length],
    ["cena", listings.filter((listing) => listing.pricePln === null).length],
    ["metraż", listings.filter((listing) => listing.areaM2 === null).length],
    ["liczba pokoi", listings.filter((listing) => listing.rooms === null).length],
  ] as const;
  const details = missing
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}: ${count}/${listings.length}`);

  return details.length > 0
    ? `Brak widocznych pól w pobranych ofertach (${details.join(", ")}); wartości pozostawiono puste.`
    : null;
}

export function createNieruchomosciOnlineAdapter(options: AdapterOptions = {}): SourceAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const maxHtmlBytes = options.maxHtmlBytes ?? MAX_HTML_BYTES;
  let lastHealthStatus: SourceAccessStatus = "NOT_TESTED";
  let lastHealthDiagnostic = "Brak jeszcze próby pobrania publicznej listy.";

  return {
    source: SOURCE,
    async discover(profile, discoverOptions): Promise<FetchBatch> {
      let baseUrl: URL;
      try {
        baseUrl = new URL(`https://${portalCitySlug(profile.city)}.${HOST}${SEARCH_PATH}`);
      } catch {
        lastHealthStatus = "FAILED";
        lastHealthDiagnostic = "Nie można zbudować bezpiecznego adresu listy ofert dla profilu.";
        return makeBatch(profile, {
          listings: [], inspectedPages: 0, requestCount: 0, isFullTraversal: false,
          sourceIsReachable: false, warnings: [],
          errors: [{ kind: "UNSUPPORTED", message: lastHealthDiagnostic, url: `https://${HOST}/` }],
        });
      }

      const pageBudget = Number.isFinite(discoverOptions.maxPages)
        ? Math.max(0, Math.floor(discoverOptions.maxPages))
        : 1;
      if (pageBudget === 0) {
        lastHealthStatus = "NOT_TESTED";
        lastHealthDiagnostic = "Nie wysłano żądania: budżet stron wynosi 0.";
        return makeBatch(profile, {
          listings: [], inspectedPages: 0, requestCount: 0, isFullTraversal: false,
          sourceIsReachable: false, warnings: [lastHealthDiagnostic], errors: [],
        });
      }

      const listings = new Map<string, FetchBatch["listings"][number]>();
      const warnings: string[] = [];
      const errors: FetchBatch["errors"] = [];
      const seenPageNumbers = new Set<number>();
      let requestCount = 0;
      let inspectedPages = 0;
      let sourceIsReachable = false;
      let isFullTraversal = false;
      let currentPage = 1;

      while (inspectedPages < pageBudget && !seenPageNumbers.has(currentPage)) {
        seenPageNumbers.add(currentPage);
        const currentUrl = pageUrl(baseUrl, currentPage);
        let pageHtml: string | null = null;
        const captureFetch: typeof fetch = async (input, init) => {
          const response = await fetchImpl(input, init);
          if (response.ok && /^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get("content-type") ?? "")) {
            try {
              pageHtml = await readBoundedHtml(response.clone(), maxHtmlBytes);
            } catch {
              pageHtml = null;
            }
          }
          return response;
        };

        const pageAdapter = createHtmlListAdapter({
          source: SOURCE,
          name: "Nieruchomosci-online.pl",
          host: HOST,
          buildSearchUrl: () => currentUrl.toString(),
          cardSelector: "[data-id]",
          linkSelector: "[data-id] a[href], a[data-id][href]",
          matchesListingPath: (url) => url.pathname !== SEARCH_PATH,
          priceSelectors: ["span.none"],
          areaSelectors: ["span.area"],
          externalId: (card) => card.attr("data-id") ?? null,
        }, { fetchImpl: captureFetch, now, maxHtmlBytes });

        const pageBatch = await pageAdapter.discover(profile, {
          ...discoverOptions,
          maxPages: 1,
        });
        const pageHealth = await pageAdapter.healthcheck();
        requestCount += pageBatch.requestCount ?? 0;
        inspectedPages += pageBatch.inspectedPages;
        sourceIsReachable ||= pageBatch.sourceIsReachable;

        if (pageBatch.errors.length > 0) {
          errors.push(...pageBatch.errors);
          lastHealthStatus = pageHealth.status;
          lastHealthDiagnostic = pageHealth.diagnostic ?? pageBatch.errors[0].message;
          if (pageBatch.errors.some((error) => error.kind === "EMPTY_CONFIRMED") && currentPage > 1) {
            warnings.push(`Strona ${currentPage} nie zawierała ofert; przerwano z niepełnym pokryciem.`);
          }
          break;
        }

        let addedOnPage = 0;
        let duplicatesOnPage = 0;
        for (const listing of pageBatch.listings) {
          const key = listing.externalId || listing.canonicalUrl;
          if (listings.has(key)) {
            duplicatesOnPage += 1;
            continue;
          }
          listings.set(key, listing);
          addedOnPage += 1;
        }

        if (addedOnPage === 0 && pageBatch.listings.length > 0) {
          warnings.push(`Strona ${currentPage} nie zawierała nowych ofert; powtórzone rekordy: ${duplicatesOnPage}. Przerwano paginację.`);
          break;
        }
        if (duplicatesOnPage > 0) {
          warnings.push(`Na stronie ${currentPage} pominięto powtórzone rekordy: ${duplicatesOnPage}.`);
        }

        const pagination = paginationState(pageHtml, currentUrl, currentPage);
        if (!pagination.known) {
          warnings.push(`Nie znaleziono jednoznacznej paginacji po stronie ${currentPage}; pełne pokrycie nie jest potwierdzone.`);
          break;
        }
        if (pagination.nextPage === null) {
          isFullTraversal = true;
          break;
        }
        if (inspectedPages >= pageBudget) {
          warnings.push(`Osiągnięto limit stron (${pageBudget}); lista wskazuje jeszcze stronę ${pagination.nextPage}.`);
          break;
        }
        currentPage = pagination.nextPage;
      }

      if (inspectedPages >= pageBudget && !isFullTraversal && errors.length === 0
        && warnings.every((warning) => !warning.startsWith("Osiągnięto limit"))) {
        warnings.push(`Pobrano stron: ${inspectedPages} (limit ${pageBudget}); pełne pokrycie nie jest potwierdzone.`);
      }

      const allListings = [...listings.values()];
      const fieldsWarning = missingFieldWarning(allListings);
      if (fieldsWarning) warnings.push(fieldsWarning);

      if (errors.length === 0 || errors.every((error) => error.kind === "EMPTY_CONFIRMED")) {
        lastHealthStatus = "LIVE_PARTIAL";
        lastHealthDiagnostic = `Odczytano ${allListings.length} unikalnych ofert z ${inspectedPages} stron; baza i widok UI niezweryfikowane.`;
      }

      return makeBatch(profile, {
        listings: allListings,
        inspectedPages,
        requestCount,
        isFullTraversal,
        sourceIsReachable,
        warnings: [...new Set(warnings)],
        errors,
      });
    },
    async healthcheck() {
      return { status: lastHealthStatus, diagnostic: lastHealthDiagnostic };
    },
  };
}

export const nieruchomosciOnlineAdapter = createNieruchomosciOnlineAdapter();
