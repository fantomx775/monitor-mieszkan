import { createHtmlListAdapter, portalCitySlug } from "../html-list-adapter";

export const sprzedajemyAdapter = createHtmlListAdapter({
  source: "sprzedajemy",
  name: "Sprzedajemy.pl",
  host: "sprzedajemy.pl",
  buildSearchUrl: (city) => `https://sprzedajemy.pl/${portalCitySlug(city)}/nieruchomosci/mieszkania/sprzedaz`,
  cardSelector: "article.element",
  linkSelector: "article.element a.offerLink[href]",
  matchesListingPath: (url) => /-nr\d+\/?$/i.test(url.pathname),
  priceSelectors: ["span.price", "[data-price]"],
  areaSelectors: ["a.offerLink"],
  roomSelectors: ["a.offerLink"],
  externalId: (_card, url) => url.pathname.match(/-nr(\d+)\/?$/i)?.[1] ?? null,
});
