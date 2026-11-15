const OTODOM_HOSTS = new Set(["www.otodom.pl", "otodom.pl"]);
const SEARCH_PATH = /^\/pl\/wyniki\/sprzedaz\/mieszkanie(?:\/|$)/i;
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "dclid", "msclkid", "yclid"]);

/** Accept only a user-supplied Otodom apartment-sale results page. */
export function normalizeOtodomSearchUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Wklej pełny adres wyników wyszukiwania Otodom.");
  }

  if (url.protocol !== "https:" || !OTODOM_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Adres musi prowadzić do domeny https://www.otodom.pl.");
  }
  if (url.username || url.password || !SEARCH_PATH.test(url.pathname)) {
    throw new Error("Adres musi prowadzić do wyników sprzedaży mieszkań na Otodom.");
  }

  url.hostname = "www.otodom.pl";
  url.hash = "";
  url.searchParams.delete("page");
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith("utm_") || TRACKING_PARAMS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

export function otodomSearchPageUrl(searchUrl: string, page: number): string {
  const url = new URL(normalizeOtodomSearchUrl(searchUrl));
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}
