import { z } from "zod";

export const SOURCE_KEYS = [
  "otodom",
  "olx",
  "morizon",
  "gratka",
  "nieruchomosci_online",
  "lento",
  "gethome",
  "sprzedajemy",
  "tabelaofert",
  "homeportal",
  "domy",
  "domiporta",
  "adresowo",
  "manual",
] as const;

export const SourceKeySchema = z.enum(SOURCE_KEYS);
export type SourceKey = z.infer<typeof SourceKeySchema>;

export const SourceAccessStatusSchema = z.enum([
  "LIVE_PASS",
  "LIVE_PARTIAL",
  "FIXTURE_ONLY",
  "BLOCKED_BY_ACCESS_OR_POLICY",
  "FAILED",
  "NOT_TESTED",
]);
export type SourceAccessStatus = z.infer<typeof SourceAccessStatusSchema>;

export const SearchProfileSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1),
  label: z.string().min(1),
  city: z.string().min(1),
  preferredDistricts: z.array(z.string()).default([]),
  priceMaxPln: z.number().int().positive().optional(),
  areaMinM2: z.number().positive().optional(),
  areaMaxM2: z.number().positive().optional(),
  preferredRooms: z.array(z.number().int().positive()).default([]),
  otodomSearchUrl: z.string().url().optional(),
  olxSearchUrl: z.string().url().optional(),
  olxSearchParams: z.object({
    categoryId: z.number().int().positive(),
    regionId: z.number().int().positive(),
    cityId: z.number().int().positive(),
    query: z.string().max(200).optional(),
    suggestFilters: z.string().max(40).optional(),
    sl: z.string().max(120).optional(),
  }).optional(),
  adresowoSearchUrl: z.string().url().optional(),
  transaction: z.literal("sale").default("sale"),
  category: z.literal("apartment").default("apartment"),
  mode: z.enum(["strict", "discovery"]),
});
export type SearchProfile = z.infer<typeof SearchProfileSchema>;

const optionalPositiveNumber = z.number().positive().nullable();
const capturedAtSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "capturedAt must be a valid timestamp",
});

export const NormalizedListingSchema = z.object({
  source: SourceKeySchema,
  externalId: z.string().trim().min(1).max(180),
  canonicalUrl: z.string().url(),
  title: z.string().trim().max(500).nullable(),
  transaction: z.literal("sale"),
  category: z.literal("apartment"),
  market: z.enum(["primary", "secondary", "unknown"]),
  pricePln: z.number().int().positive().nullable(),
  areaM2: optionalPositiveNumber,
  rooms: z.number().int().positive().nullable(),
  floor: z.number().int().nullable(),
  city: z.string().trim().max(160).nullable(),
  district: z.string().trim().max(160).nullable(),
  street: z.string().trim().max(200).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  publishedAt: z.string().nullable(),
  promotedAt: z.string().nullable(),
  imageOriginalUrl: z.string().url().nullable(),
  imageAlt: z.string().max(300).nullable(),
  propertyFeatures: z.array(z.string().max(100)).max(40),
  sourceEvidence: z.enum(["rss", "jsonld", "html", "browser", "manual"]),
  capturedAt: capturedAtSchema,
});
export type NormalizedListing = z.infer<typeof NormalizedListingSchema>;

export const ScrapeErrorKindSchema = z.enum([
  "ACCESS_DENIED",
  "CAPTCHA",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK",
  "PARSE_CHANGED",
  "EMPTY_CONFIRMED",
  "LOCKED",
  "POLICY_BLOCKED",
  "BUDGET_EXHAUSTED",
  "UNSUPPORTED",
  "INTERNAL",
]);
export type ScrapeErrorKind = z.infer<typeof ScrapeErrorKindSchema>;

export const FetchBatchSchema = z.object({
  source: SourceKeySchema,
  profileId: z.string().uuid(),
  listings: z.array(NormalizedListingSchema),
  inspectedPages: z.number().int().nonnegative(),
  requestCount: z.number().int().nonnegative().optional(),
  isFullTraversal: z.boolean(),
  sourceIsReachable: z.boolean(),
  warnings: z.array(z.string()),
  skippedCounts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  errors: z.array(
    z.object({
      kind: ScrapeErrorKindSchema,
      message: z.string(),
      url: z.string().url().optional(),
    }),
  ),
});
export type FetchBatch = z.infer<typeof FetchBatchSchema>;

export interface SourceAdapter {
  readonly source: SourceKey;
  discover(
    profile: SearchProfile,
    options: { dryRun: boolean; maxPages: number; since?: string; verbose?: boolean; signal?: AbortSignal },
  ): Promise<FetchBatch>;
  fetchDetail?(url: string, signal?: AbortSignal): Promise<NormalizedListing | null>;
  healthcheck(): Promise<{ status: SourceAccessStatus; diagnostic?: string }>;
}
