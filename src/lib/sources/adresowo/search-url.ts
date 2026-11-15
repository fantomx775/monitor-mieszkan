const HOSTS = new Set(["adresowo.pl", "www.adresowo.pl"]);
const SEARCH_PATH = /^\/(?:f\/)?mieszkania\/[^/]+(?:\/[^/]+)*(?:\/_l\d+)?\/?$/i;
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gbraid",
  "gad_source",
  "gad_campaignid",
  "dclid",
  "msclkid",
  "yclid",
]);

/** Validate and normalize a user-provided Adresowo apartment search page. */
export function normalizeAdresowoSearchUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Wklej pełny adres wyników wyszukiwania Adresowo.");
  }

  if (url.protocol !== "https:" || !HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Adres musi prowadzić do domeny https://adresowo.pl.");
  }
  if (url.username || url.password || url.port || url.hash || !SEARCH_PATH.test(url.pathname)) {
    throw new Error("Adres musi prowadzić do publicznych wyników mieszkań na Adresowo.");
  }

  url.hostname = "adresowo.pl";
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith("utm_") || TRACKING_PARAMS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}
