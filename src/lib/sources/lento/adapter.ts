import { createHtmlListAdapter, portalCitySlug } from "../html-list-adapter";

export const lentoAdapter = createHtmlListAdapter({
  source: "lento",
  name: "Lento.pl",
  host: "lento.pl",
  buildSearchUrl: (city) => `https://${portalCitySlug(city)}.lento.pl/nieruchomosci/mieszkania/sprzedaz.html`,
  cardSelector: "[data-id]",
  linkSelector: "[data-id] a.title-list-item, a.title-list-item[data-id]",
  matchesListingPath: (url, searchUrl) => url.pathname !== searchUrl.pathname,
  priceSelectors: ["span.price-list-item"],
  areaSelectors: ["span.list-atrr-item-tab"],
  roomSelectors: ["span.list-atrr-item-tab"],
  externalId: (card) => card.attr("data-id") ?? null,
});
