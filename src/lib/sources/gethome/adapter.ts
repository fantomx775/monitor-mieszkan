import { createHtmlListAdapter, portalCitySlug } from "../html-list-adapter";

export const getHomeAdapter = createHtmlListAdapter({
  source: "gethome",
  name: "GetHome.pl",
  host: "gethome.pl",
  buildSearchUrl: (city) => `https://gethome.pl/nieruchomosci/${portalCitySlug(city)}/`,
  linkSelector: 'a[href*="/oferta/"]',
  matchesListingPath: (url) => /^\/oferta\/[^/]+\/?$/i.test(url.pathname),
  priceSelectors: ['[class*="price"]', '[class*="cena"]', "[data-price]"],
  areaSelectors: ['[class*="area"]', '[class*="metraz"]', '[class*="powierzchn"]', "[data-area]"],
  roomSelectors: ['[class*="room"]', '[class*="poko"]', "[data-rooms]"],
});
