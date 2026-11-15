import { createHtmlListAdapter, portalCitySlug } from "../html-list-adapter";

export const tabelaOfertAdapter = createHtmlListAdapter({
  source: "tabelaofert",
  name: "TabelaOfert.pl",
  host: "tabelaofert.pl",
  buildSearchUrl: (city) => `https://tabelaofert.pl/sprzedaz/mieszkania/${portalCitySlug(city)}`,
  cardSelector: 'article[class*="oferta"]',
  linkSelector: 'article[class*="oferta"] a[href*="/oferta/"]',
  matchesListingPath: (url) => /^\/oferta\/[^/]+\/?$/i.test(url.pathname),
  priceSelectors: ['[class*="cena"]', "[data-price]"],
  areaSelectors: ['[class*="nazwa"]', '[class*="opis"]', "[data-area]"],
  roomSelectors: ['[class*="nazwa"]', '[class*="opis"]', "[data-rooms]"],
});
