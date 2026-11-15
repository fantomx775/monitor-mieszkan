import { createHash } from "node:crypto";

import { SOURCE_KEYS, type SourceKey } from "./contracts";

const HOSTS: Record<SourceKey, readonly string[]> = {
  otodom: ["otodom.pl"],
  olx: ["olx.pl"],
  morizon: ["morizon.pl"],
  gratka: ["gratka.pl"],
  nieruchomosci_online: ["nieruchomosci-online.pl"],
  lento: ["lento.pl"],
  gethome: ["gethome.pl"],
  sprzedajemy: ["sprzedajemy.pl"],
  tabelaofert: ["tabelaofert.pl"],
  homeportal: ["homeportal.pl"],
  domy: ["domy.pl"],
  domiporta: ["domiporta.pl"],
  adresowo: ["adresowo.pl"],
  manual: [
    "otodom.pl",
    "olx.pl",
    "morizon.pl",
    "gratka.pl",
    "nieruchomosci-online.pl",
    "lento.pl",
    "gethome.pl",
    "sprzedajemy.pl",
    "tabelaofert.pl",
    "homeportal.pl",
    "domy.pl",
    "domiporta.pl",
    "adresowo.pl",
  ],
};

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "yclid",
  "ref",
  "referrer",
]);

export function canonicalizeListingUrl(source: SourceKey, input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Nieprawidłowy adres URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Dozwolone są wyłącznie adresy http i https");
  }
  if (url.username || url.password) {
    throw new Error("Adres URL nie może zawierać danych logowania");
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!HOSTS[source].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new Error("Adres nie należy do dozwolonej domeny tego źródła");
  }

  url.protocol = "https:";
  url.hostname = hostname;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith("utm_") || TRACKING_PARAMS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

export function stableExternalId(source: SourceKey, canonicalUrl: string, suppliedId?: string | null): string {
  if (suppliedId?.trim()) return suppliedId.trim();

  const url = new URL(canonicalUrl);
  const path = decodeURIComponent(url.pathname);
  const patterns: Partial<Record<SourceKey, RegExp>> = {
    otodom: /(?:^|-)ID([a-z0-9]+)\/?$/i,
    olx: /(?:^|-)ID([a-z0-9]+)(?:\.html)?\/?$/i,
    morizon: /(mzn\d+)/i,
    sprzedajemy: /(?:-nr)(\d+)/i,
    domy: /(dol\d+)/i,
    domiporta: /\/(\d{6,})\/?$/,
  };
  const match = patterns[source]?.exec(path);
  if (match?.[1]) return match[1];

  return createHash("sha256").update(source + ":" + url.origin + url.pathname).digest("hex");
}

function parseLocalizedNumber(rawValue: string): number | null {
  const value = rawValue
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, "")
    .trim();
  if (!value || !/\d/.test(value)) return null;

  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  let decimalSeparator: "," | "." | null = null;

  if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastComma > lastDot ? "," : ".";
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? "," : ".";
    const separatorIndex = separator === "," ? lastComma : lastDot;
    const digitsAfter = value.length - separatorIndex - 1;
    if (digitsAfter > 0 && digitsAfter < 3) decimalSeparator = separator;
  }

  let normalized = value;
  if (decimalSeparator) {
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    normalized = normalized.split(groupingSeparator).join("");
    const decimalIndex = normalized.lastIndexOf(decimalSeparator);
    normalized =
      normalized.slice(0, decimalIndex).replace(/[,.]/g, "") +
      "." +
      normalized.slice(decimalIndex + 1).replace(/[,.]/g, "");
  } else {
    normalized = normalized.replace(/[,.]/g, "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePricePln(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (!value) return null;

  const text = value.toLocaleLowerCase("pl-PL").replace(/[\u00a0\u202f]/g, " ");
  if (/zł\s*\/\s*(?:m²|m2)|pln\s*\/\s*(?:m²|m2)/i.test(text)) return null;
  if (/\b(?:od|około|ok\.?|zapytaj|do uzgodnienia|cena na telefon)\b/i.test(text)) return null;

  const numberMatch = text.match(/\d[\d\s.,]*/);
  if (!numberMatch) return null;
  const parsed = parseLocalizedNumber(numberMatch[0]);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseAreaM2(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (!value) return null;
  const match = value
    .replace(/[\u00a0\u202f]/g, " ")
    .match(/\d[\d\s.,]*(?=\s*(?:m²|m2|metr|$))/i);
  if (!match) return null;
  const parsed = parseLocalizedNumber(match[0]);
  return parsed !== null && parsed > 0 ? Math.round(parsed * 100) / 100 : null;
}

export function parseRoomCount(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (!value) return null;
  const match = value.match(/\b(\d{1,2})\s*(?:pok[oó]j(?:e|i|ów)?|p\.|rooms?)\b/i);
  if (!match) return null;
  const rooms = Number(match[1]);
  return Number.isSafeInteger(rooms) && rooms > 0 ? rooms : null;
}

export function isSupportedSource(value: string): value is SourceKey {
  return (SOURCE_KEYS as readonly string[]).includes(value);
}
