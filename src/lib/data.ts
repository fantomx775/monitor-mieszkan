import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type ListingRow = {
  id: string;
  source_key: string;
  external_id: string;
  canonical_url: string;
  title: string | null;
  market: "primary" | "secondary" | "unknown";
  price_pln: number | null;
  area_m2: number | null;
  rooms: number | null;
  floor: number | null;
  city: string | null;
  district: string | null;
  street: string | null;
  published_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_checked_at: string | null;
  life_cycle: string;
  source_evidence: string;
  image_original_url: string | null;
  expected_rent_pln?: number | null;
  admin_fees_pln?: number | null;
  renovation_cost_pln?: number | null;
  acquisition_cost_pln?: number | null;
};

export type ListingState = {
  listing_id: string;
  favorite: boolean;
  review_status: string;
  reviewed_at: string | null;
  viewing_scheduled_at: string | null;
  updated_at: string;
};

export type WorkspaceContext = {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
  userId: string;
  displayName: string;
};

export async function requireWorkspace(): Promise<WorkspaceContext> {
  const supabase = await createSupabaseServerClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (typeof userId !== "string") redirect("/login");

  const [{ data: membership, error }, { data: userData }] = await Promise.all([
    supabase.from("workspace_members").select("workspace_id").eq("user_id", userId).limit(1).maybeSingle(),
    supabase.auth.getUser(),
  ]);
  if (error || !membership?.workspace_id) redirect("/login?error=workspace");
  const displayName =
    (typeof userData.user?.user_metadata?.display_name === "string" && userData.user.user_metadata.display_name) ||
    "Użytkownik";
  return { supabase, workspaceId: membership.workspace_id, userId, displayName };
}

export async function loadListingStates(
  supabase: WorkspaceContext["supabase"],
  workspaceId: string,
  ids: string[],
) {
  if (!ids.length) return new Map<string, ListingState>();
  const { data } = await supabase
    .from("listing_user_state")
    .select("listing_id,favorite,review_status,reviewed_at,viewing_scheduled_at,updated_at")
    .eq("workspace_id", workspaceId)
    .in("listing_id", ids);
  return new Map((data ?? []).map((row) => [row.listing_id, row as ListingState]));
}

export const pln = (value: number | null) =>
  value == null ? "Cena do uzupełnienia" : new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value);

export const compactPln = (value: number | null) =>
  value == null ? "—" : new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(value);

export const dateTime = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Warsaw" }).format(new Date(value))
    : "Brak danych";

export const reviewLabels: Record<string, string> = {
  to_review: "Do przejrzenia",
  interesting: "Interesujące",
  to_contact: "Do kontaktu",
  contacted: "Kontaktowano",
  to_view: "Do obejrzenia",
  rejected: "Odrzucone",
  archived: "Archiwum",
};

export const sourceLabels: Record<string, string> = {
  otodom: "Otodom",
  olx: "OLX",
  morizon: "Morizon",
  gratka: "Gratka",
  nieruchomosci_online: "Nieruchomosci-online.pl",
  lento: "Lento.pl",
  gethome: "GetHome.pl",
  sprzedajemy: "Sprzedajemy.pl",
  tabelaofert: "TabelaOfert.pl",
  homeportal: "HomePortal.pl",
  domy: "Domy.pl",
  domiporta: "Domiporta",
  adresowo: "Adresowo",
  manual: "Dodane ręcznie",
};
