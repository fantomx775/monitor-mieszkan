import { createHtmlListAdapter, portalCitySlug } from "../html-list-adapter";

const REGIONS: Record<string, string> = {
  gliwice: "slaskie",
  katowice: "slaskie",
  krakow: "malopolskie",
  tychy: "slaskie",
};

export const homePortalAdapter = createHtmlListAdapter({
  source: "homeportal",
  name: "HomePortal.pl",
  host: "homeportal.pl",
  buildSearchUrl: (city) => {
    const slug = portalCitySlug(city);
    const region = REGIONS[slug] ?? "slaskie";
    return `https://homeportal.pl/sprzedaz/mieszkania/${region}/${slug}/`;
  },
  cardSelector: "article",
  linkSelector: 'article a[href*="/sprzedaz/"]',
  matchesListingPath: (url, searchUrl) =>
    url.pathname.startsWith("/sprzedaz/")
    && url.pathname !== searchUrl.pathname
    && url.pathname.split("/").filter(Boolean).length >= 5,
  priceSelectors: ['[class*="price"]', '[class*="cena"]', "[data-price]"],
  areaSelectors: ['[class*="area"]', '[class*="metraz"]', '[class*="powierzchn"]', "[data-area]"],
  roomSelectors: ['[class*="room"]', '[class*="poko"]', "[data-rooms]"],
});
