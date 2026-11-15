"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/data";
import { canonicalizeListingUrl, stableExternalId } from "@/lib/sources/normalization";
import { normalizeOtodomSearchUrl } from "@/lib/sources/otodom/search-url";
import { normalizeAdresowoSearchUrl } from "@/lib/sources/adresowo/search-url";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const idSchema = z.string().uuid();
const statusSchema = z.enum(["to_review", "interesting", "to_contact", "contacted", "to_view", "rejected", "archived"]);
const duplicateResolutionSchema = z.enum(["confirmed", "rejected"]);
const optionalMoney = z.preprocess(
  (value) => value === "" || value == null ? null : Number(value),
  z.number().int().min(0).max(100_000_000).nullable(),
);
const sourceKeys = ["otodom", "olx", "morizon", "gratka", "nieruchomosci_online", "lento", "gethome", "sprzedajemy", "tabelaofert", "homeportal", "domy", "domiporta", "adresowo"] as const;

function normalizeOlxSearchUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Wklej pełny adres wyników wyszukiwania OLX.");
  }
  if (
    url.protocol !== "https:" ||
    !["www.olx.pl", "olx.pl"].includes(url.hostname.toLowerCase()) ||
    !url.pathname.toLowerCase().startsWith("/nieruchomosci/") ||
    url.username || url.password
  ) {
    throw new Error("Adres musi prowadzić do wyników kategorii Nieruchomości na OLX.");
  }
  url.hostname = "www.olx.pl";
  url.hash = "";
  return url.toString();
}

export async function signIn(formData: FormData) {
  const email = z.string().email().safeParse(formData.get("email"));
  const password = z.string().min(1).safeParse(formData.get("password"));
  if (!email.success || !password.success) redirect("/login?error=credentials");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email: email.data, password: password.data });
  if (error) redirect("/login?error=credentials");
  const next = formData.get("next");
  const destination = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  redirect(destination);
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function toggleFavorite(listingId: string) {
  const parsed = idSchema.safeParse(listingId);
  if (!parsed.success) throw new Error("Nieprawidłowa oferta.");
  const { supabase, workspaceId, userId } = await requireWorkspace();
  const { data: current } = await supabase
    .from("listing_user_state")
    .select("favorite")
    .eq("workspace_id", workspaceId)
    .eq("listing_id", listingId)
    .maybeSingle();
  const { error } = await supabase.from("listing_user_state").upsert(
    { workspace_id: workspaceId, listing_id: listingId, favorite: !current?.favorite, updated_by: userId },
    { onConflict: "workspace_id,listing_id" },
  );
  if (error) throw new Error("Nie udało się zapisać ulubionej oferty.");
  revalidatePath("/");
  revalidatePath("/oferty");
  revalidatePath("/ulubione");
  revalidatePath(`/oferty/${listingId}`);
}

export async function setReviewStatus(listingId: string, formData: FormData) {
  const parsedId = idSchema.safeParse(listingId);
  const parsedStatus = statusSchema.safeParse(formData.get("status"));
  if (!parsedId.success || !parsedStatus.success) throw new Error("Nieprawidłowy status oferty.");
  const { supabase, workspaceId, userId } = await requireWorkspace();
  const { error } = await supabase.from("listing_user_state").upsert(
    {
      workspace_id: workspaceId,
      listing_id: listingId,
      review_status: parsedStatus.data,
      reviewed_at: parsedStatus.data === "to_review" ? null : new Date().toISOString(),
      updated_by: userId,
    },
    { onConflict: "workspace_id,listing_id" },
  );
  if (error) throw new Error("Nie udało się zmienić statusu oferty.");
  revalidatePath("/");
  revalidatePath("/oferty");
  revalidatePath("/do-kontaktu");
  revalidatePath(`/oferty/${listingId}`);
}

export async function addNote(listingId: string, formData: FormData) {
  const parsedId = idSchema.safeParse(listingId);
  const parsedBody = z.string().trim().min(1).max(4000).safeParse(formData.get("body"));
  if (!parsedId.success || !parsedBody.success) throw new Error("Notatka musi mieć od 1 do 4000 znaków.");
  const { supabase, workspaceId, userId } = await requireWorkspace();
  const { error } = await supabase.from("listing_notes").insert({
    workspace_id: workspaceId,
    listing_id: listingId,
    author_id: userId,
    body: parsedBody.data,
  });
  if (error) throw new Error("Nie udało się zapisać notatki.");
  revalidatePath(`/oferty/${listingId}`);
}

export async function saveInvestmentInputs(listingId: string, formData: FormData) {
  const parsedId = idSchema.safeParse(listingId);
  const payload = z.object({
    expectedRent: optionalMoney,
    adminFees: optionalMoney,
    renovationCost: optionalMoney,
    acquisitionCost: optionalMoney,
  }).safeParse({
    expectedRent: formData.get("expected_rent_pln"),
    adminFees: formData.get("admin_fees_pln"),
    renovationCost: formData.get("renovation_cost_pln"),
    acquisitionCost: formData.get("acquisition_cost_pln"),
  });
  if (!parsedId.success || !payload.success) throw new Error("Kwoty muszą być liczbami całkowitymi od 0 do 100 000 000 zł.");

  const { supabase, workspaceId } = await requireWorkspace();
  const { error } = await supabase.rpc("save_listing_investment_inputs", {
    p_workspace_id: workspaceId,
    p_listing_id: parsedId.data,
    p_expected_rent_pln: payload.data.expectedRent,
    p_admin_fees_pln: payload.data.adminFees,
    p_renovation_cost_pln: payload.data.renovationCost,
    p_acquisition_cost_pln: payload.data.acquisitionCost,
  });
  if (error) throw new Error("Nie udało się zapisać założeń inwestycyjnych.");
  revalidatePath(`/oferty/${parsedId.data}`);
  revalidatePath("/oferty");
}

export async function resolveDuplicateCandidate(candidateId: string, formData: FormData) {
  const parsedId = idSchema.safeParse(candidateId);
  const parsedState = duplicateResolutionSchema.safeParse(formData.get("resolved_state"));
  if (!parsedId.success || !parsedState.success) throw new Error("Nieprawidłowa decyzja o podobnych ofertach.");

  const { supabase, workspaceId, userId } = await requireWorkspace();
  const { data: candidate, error: readError } = await supabase
    .from("listing_duplicate_candidates")
    .select("id,source_listing_id,candidate_listing_id,resolved_state")
    .eq("workspace_id", workspaceId)
    .eq("id", candidateId)
    .maybeSingle();
  if (readError || !candidate) throw new Error("Nie znaleziono kandydata w tym workspace.");
  if (candidate.resolved_state !== "open") throw new Error("Ten kandydat został już rozstrzygnięty.");

  const { data: updated, error: updateError } = await supabase
    .from("listing_duplicate_candidates")
    .update({
      resolved_state: parsedState.data,
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", candidateId)
    .eq("resolved_state", "open")
    .select("id")
    .maybeSingle();
  if (updateError || !updated) throw new Error("Nie udało się zapisać decyzji; kandydat mógł zostać rozstrzygnięty wcześniej.");

  revalidatePath(`/oferty/${candidate.source_listing_id}`);
  revalidatePath(`/oferty/${candidate.candidate_listing_id}`);
  revalidatePath("/oferty");
}

export async function addManualListing(formData: FormData) {
  const parsed = z
    .object({
      url: z.string().trim().url(),
      city: z.string().trim().max(160).optional(),
      district: z.string().trim().max(160).optional(),
      title: z.string().trim().max(500).optional(),
      price: z.coerce.number().int().positive().nullable().optional(),
      area: z.coerce.number().positive().nullable().optional(),
      rooms: z.coerce.number().int().positive().nullable().optional(),
    })
    .safeParse({
      url: formData.get("url"),
      city: formData.get("city") || undefined,
      district: formData.get("district") || undefined,
      title: formData.get("title") || undefined,
      price: formData.get("price") || null,
      area: formData.get("area") || null,
      rooms: formData.get("rooms") || null,
    });
  if (!parsed.success) throw new Error("Sprawdź link i wpisane parametry.");
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeListingUrl("manual", parsed.data.url);
  } catch {
    throw new Error("Link musi prowadzić do rozpoznawanego portalu ogłoszeniowego.");
  }

  const { supabase, workspaceId } = await requireWorkspace();
  const externalId = stableExternalId("manual", canonicalUrl);
  const { data, error } = await supabase
    .from("source_listings")
    .insert({
      workspace_id: workspaceId,
      source_key: "manual",
      external_id: externalId,
      canonical_url: canonicalUrl,
      title: parsed.data.title || null,
      city: parsed.data.city || null,
      district: parsed.data.district || null,
      price_pln: parsed.data.price ?? null,
      area_m2: parsed.data.area ?? null,
      rooms: parsed.data.rooms ?? null,
      source_evidence: "manual",
      data_quality: { manual: true },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error("Nie udało się zapisać linku.");
  revalidatePath("/oferty");
  redirect(`/oferty/${data.id}`);
}

export async function updateSearchProfile(profileId: string, formData: FormData) {
  const parsedId = idSchema.safeParse(profileId);
  const otodomSearchUrlInput = String(formData.get("otodom_search_url") ?? "").trim();
  const olxSearchUrlInput = String(formData.get("olx_search_url") ?? "").trim();
  const adresowoSearchUrlInput = String(formData.get("adresowo_search_url") ?? "").trim();
  let otodomSearchUrl: string | null = null;
  let olxSearchUrl: string | null = null;
  let adresowoSearchUrl: string | null = null;
  if (otodomSearchUrlInput) {
    try {
      otodomSearchUrl = normalizeOtodomSearchUrl(otodomSearchUrlInput);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Nieprawidłowy link Otodom.");
    }
  }
  if (olxSearchUrlInput) olxSearchUrl = normalizeOlxSearchUrl(olxSearchUrlInput);
  if (adresowoSearchUrlInput) {
    try {
      adresowoSearchUrl = normalizeAdresowoSearchUrl(adresowoSearchUrlInput);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Nieprawidłowy link Adresowo.");
    }
  }
  const preferredRooms = z.array(z.coerce.number().int().min(1).max(10)).max(10).safeParse(
    String(formData.get("preferred_rooms") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  );
  const optionalOlxId = z.preprocess(
    (value) => value === "" || value == null ? null : Number(value),
    z.number().int().positive().max(2_147_483_647).nullable(),
  );
  const olxParamsPayload = z.object({
    categoryId: optionalOlxId,
    regionId: optionalOlxId,
    cityId: optionalOlxId,
    query: z.string().trim().max(200),
    suggestFilters: z.string().trim().max(40),
    sl: z.string().trim().max(120),
  }).safeParse({
    categoryId: formData.get("olx_category_id"),
    regionId: formData.get("olx_region_id"),
    cityId: formData.get("olx_city_id"),
    query: formData.get("olx_query") ?? "",
    suggestFilters: formData.get("olx_suggest_filters") ?? "true",
    sl: formData.get("olx_sl") ?? "",
  });
  const payload = z.object({
    label: z.string().trim().min(1).max(160),
    city: z.string().trim().min(1).max(160),
    preferred_districts: z.array(z.string().trim().min(1).max(160)).max(20),
    price_max_pln: z.coerce.number().int().positive().max(100_000_000).nullable(),
    area_min_m2: z.coerce.number().positive().max(1000).nullable(),
    area_max_m2: z.coerce.number().positive().max(1000).nullable(),
    mode: z.enum(["strict", "discovery"]),
    enabled: z.boolean(),
    sources: z.array(z.enum(sourceKeys)).min(1),
  }).safeParse({
    label: formData.get("label"),
    city: formData.get("city"),
    preferred_districts: String(formData.get("preferred_districts") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    price_max_pln: formData.get("price_max_pln") || null,
    area_min_m2: formData.get("area_min_m2") || null,
    area_max_m2: formData.get("area_max_m2") || null,
    mode: formData.get("mode"),
    enabled: formData.get("enabled") === "on",
    sources: formData.getAll("sources").map(String),
  });
  if (!parsedId.success || !payload.success || !preferredRooms.success || !olxParamsPayload.success) throw new Error("Sprawdź wartości profilu wyszukiwania.");
  const olxIds = [olxParamsPayload.data.categoryId, olxParamsPayload.data.regionId, olxParamsPayload.data.cityId];
  if (olxIds.some((value) => value !== null) && olxIds.some((value) => value === null)) {
    throw new Error("Uzupełnij wszystkie trzy ID OLX albo zostaw je puste.");
  }
  const olxSearchParams = olxIds.every((value) => value !== null)
    ? {
        categoryId: olxParamsPayload.data.categoryId!,
        regionId: olxParamsPayload.data.regionId!,
        cityId: olxParamsPayload.data.cityId!,
        query: olxParamsPayload.data.query,
        suggestFilters: olxParamsPayload.data.suggestFilters || "true",
        ...(olxParamsPayload.data.sl ? { sl: olxParamsPayload.data.sl } : {}),
      }
    : null;
  const value = payload.data;
  if (value.area_min_m2 != null && value.area_max_m2 != null && value.area_min_m2 > value.area_max_m2) {
    throw new Error("Minimalny metraż nie może przekraczać maksymalnego.");
  }
  const { supabase, workspaceId } = await requireWorkspace();
  const { data: currentProfile, error: currentProfileError } = await supabase
    .from("search_profiles")
    .select("filters")
    .eq("id", profileId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (currentProfileError || !currentProfile) throw new Error("Nie udało się odczytać konfiguracji profilu.");
  const currentFilters = currentProfile.filters && typeof currentProfile.filters === "object" && !Array.isArray(currentProfile.filters)
    ? { ...currentProfile.filters as Record<string, unknown> }
    : {};
  if (otodomSearchUrl) currentFilters.otodom_search_url = otodomSearchUrl;
  else delete currentFilters.otodom_search_url;
  if (olxSearchUrl) currentFilters.olx_search_url = olxSearchUrl;
  else delete currentFilters.olx_search_url;
  if (adresowoSearchUrl) currentFilters.adresowo_search_url = adresowoSearchUrl;
  else delete currentFilters.adresowo_search_url;
  if (olxSearchParams) currentFilters.olx_search_params = olxSearchParams;
  else delete currentFilters.olx_search_params;
  const { error } = await supabase.from("search_profiles").update({
    label: value.label,
    city: value.city,
    preferred_districts: value.preferred_districts,
    price_max_pln: value.price_max_pln,
    area_min_m2: value.area_min_m2,
    area_max_m2: value.area_max_m2,
    preferred_rooms: preferredRooms.data,
    mode: value.mode,
    enabled: value.enabled,
    sources: value.sources,
    filters: currentFilters,
  }).eq("id", profileId).eq("workspace_id", workspaceId);
  if (error) throw new Error("Nie udało się zapisać profilu.");
  revalidatePath("/");
  revalidatePath("/wyszukiwania");
  revalidatePath("/zrodla");
}
