import Link from "next/link";
import { Plus, Search, X } from "lucide-react";
import { AppShell } from "@/app/_components/app-shell";
import { ListingCard } from "@/app/_components/listing-card";
import { loadListingStates, requireWorkspace, sourceLabels, type ListingRow } from "@/lib/data";

type Params = Record<string, string | undefined>;
type ListMode = "all" | "favorites" | "contact";

const PAGE_SIZE = 40;
const SORT_SCAN_LIMIT = 10_000;
const SORT_SCAN_BATCH = 1_000;
const allowedReviewStatuses = new Set(["to_review", "interesting", "to_contact", "contacted", "to_view", "rejected", "archived"]);
const allowedLifeCycles = new Set(["active", "potentially_stale", "gone", "archived"]);
const allowedSources = new Set(Object.keys(sourceLabels));
const allowedMarkets = new Set(["primary", "secondary", "unknown"]);
const allowedSorts = new Set(["newest", "published", "price_asc", "price_desc", "area_asc", "area_desc", "price_m2_asc", "price_m2_desc", "drop_desc"]);

const safeInteger = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const safeDecimal = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const safeSearchText = (value: string | undefined) =>
  (value ?? "").replace(/[^\p{L}\p{N}\s-]/gu, " ").trim().replace(/\s+/g, " ").slice(0, 120);
const validOneOf = (value: string | undefined, allowed: Set<string>) => (value && allowed.has(value) ? value : null);
const isoDaysBeforeNow = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

function listingQuery(supabase: Awaited<ReturnType<typeof requireWorkspace>>["supabase"], workspaceId: string, filters: {
  stateIds: string[] | null;
  priceDropIds: string[] | null;
  profileListingIds: string[] | null;
  params: Params;
}) {
  const { stateIds, priceDropIds, profileListingIds, params } = filters;
  let query = supabase
    .from("source_listings")
    .select("id,source_key,external_id,canonical_url,title,market,price_pln,area_m2,rooms,floor,city,district,street,published_at,first_seen_at,last_seen_at,last_checked_at,life_cycle,source_evidence,image_original_url,image_storage_path", { count: "exact" })
    .eq("workspace_id", workspaceId);

  if (stateIds) query = stateIds.length ? query.in("id", stateIds) : query.eq("id", "00000000-0000-4000-8000-000000000000");
  if (priceDropIds) query = priceDropIds.length ? query.in("id", priceDropIds) : query.eq("id", "00000000-0000-4000-8000-000000000000");

  if (profileListingIds) query = profileListingIds.length ? query.in("id", profileListingIds) : query.eq("id", "00000000-0000-0000-0000-000000000000");

  const searchText = safeSearchText(params.q);
  if (searchText) query = query.or(`title.ilike.%${searchText}%,city.ilike.%${searchText}%,district.ilike.%${searchText}%,street.ilike.%${searchText}%`);
  const city = safeSearchText(params.city);
  const district = safeSearchText(params.district);
  if (city) query = query.ilike("city", `%${city}%`);
  if (district) query = query.ilike("district", `%${district}%`);

  const source = validOneOf(params.source, allowedSources);
  const market = validOneOf(params.market, allowedMarkets);
  if (source) query = query.eq("source_key", source);
  if (market) query = query.eq("market", market);

  const minPrice = safeInteger(params.minPrice);
  const maxPrice = safeInteger(params.maxPrice);
  const minArea = safeDecimal(params.minArea);
  const maxArea = safeDecimal(params.maxArea);
  if (minPrice != null) query = query.gte("price_pln", minPrice);
  if (maxPrice != null) query = query.lte("price_pln", maxPrice);
  if (minArea != null) query = query.gte("area_m2", minArea);
  if (maxArea != null) query = query.lte("area_m2", maxArea);

  if (params.rooms && ["1", "2", "3", "4+"].includes(params.rooms)) {
    query = params.rooms === "4+" ? query.gte("rooms", 4) : query.eq("rooms", Number(params.rooms));
  }
  if (params.hasImage === "1") query = query.eq("has_image", true);
  const lifeCycle = validOneOf(params.lifecycle, allowedLifeCycles) ?? (params.active === "0" ? null : "active");
  if (lifeCycle) query = query.eq("life_cycle", lifeCycle);

  const recentDays = params.recent && ["1", "3", "7", "30"].includes(params.recent)
    ? Number(params.recent)
    : params.new === "1" ? 1 : null;
  if (recentDays) query = query.gte("first_seen_at", new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString());
  return query;
}

export async function ListingListPage({ params, mode = "all" }: { params: Params; mode?: ListMode }) {
  const { supabase, workspaceId, displayName } = await requireWorkspace();
  const page = Math.min(1000, Math.max(1, safeInteger(params.page) ?? 1));
  const { data: profiles } = await supabase.from("search_profiles")
    .select("id,profile_key,label,enabled")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .order("label");
  const selectedProfile = profiles?.find((profile) => profile.profile_key === params.profile);
  let profileListingIds: string[] | null = null;
  if (params.profile) {
    if (selectedProfile) {
      const { data: matches } = await supabase.from("listing_profile_matches")
        .select("listing_id")
        .eq("workspace_id", workspaceId)
        .eq("profile_id", selectedProfile.id)
        .limit(SORT_SCAN_LIMIT);
      profileListingIds = (matches ?? []).map((match) => match.listing_id);
    } else {
      profileListingIds = [];
    }
  }
  let stateIds: string[] | null = null;
  const review = validOneOf(params.review, allowedReviewStatuses);
  if (mode === "favorites" || mode === "contact" || review) {
    let stateQuery = supabase.from("listing_user_state").select("listing_id").eq("workspace_id", workspaceId);
    if (mode === "favorites") stateQuery = stateQuery.eq("favorite", true);
    if (mode === "contact") stateQuery = stateQuery.in("review_status", ["to_contact", "contacted"]);
    else if (review) stateQuery = stateQuery.eq("review_status", review);
    const { data } = await stateQuery.limit(SORT_SCAN_LIMIT);
    stateIds = (data ?? []).map((row) => row.listing_id);
  }

  const sort = validOneOf(params.sort, allowedSorts) ?? "newest";
  let priceDropIds: string[] | null = null;
  let dropEvents: Array<{ listing_id: string; old_price_pln: number; new_price_pln: number; observed_at: string }> = [];
  let dropEventsError = false;
  if (params.priceDrop === "1" || sort === "drop_desc") {
    const lookbackDays = params.priceDrop === "1" ? 30 : 365;
    const { data, error } = await supabase
      .from("listing_price_events")
      .select("listing_id,old_price_pln,new_price_pln,observed_at")
      .eq("workspace_id", workspaceId)
      .gte("observed_at", isoDaysBeforeNow(lookbackDays))
      .order("observed_at", { ascending: false })
      .limit(SORT_SCAN_LIMIT);
    dropEventsError = Boolean(error);
    dropEvents = (data ?? []).filter((event) => Number(event.new_price_pln) < Number(event.old_price_pln));
    if (params.priceDrop === "1") priceDropIds = [...new Set(dropEvents.map((event) => event.listing_id))];
  }

  const filters = { stateIds, priceDropIds, profileListingIds, params };
  const sortColumn = sort === "published" ? "published_at"
    : sort === "price_asc" || sort === "price_desc" ? "price_pln"
      : sort === "area_asc" || sort === "area_desc" ? "area_m2"
        : sort === "price_m2_asc" || sort === "price_m2_desc" ? "price_per_m2"
          : "first_seen_at";
  const ascending = ["price_asc", "area_asc", "price_m2_asc"].includes(sort);
  let listings: ListingRow[] = [];
  let count = 0;
  let error: unknown = null;
  let sortLimited = false;

  if (sort === "drop_desc") {
    const rows: ListingRow[] = [];
    for (let offset = 0; offset < SORT_SCAN_LIMIT; offset += SORT_SCAN_BATCH) {
      const { data, error: chunkError, count: totalCount } = await listingQuery(supabase, workspaceId, filters)
        .order("first_seen_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(offset, offset + SORT_SCAN_BATCH - 1);
      if (chunkError) { error = chunkError; break; }
      count = totalCount ?? count;
      rows.push(...((data ?? []) as ListingRow[]));
      if (!data || data.length < SORT_SCAN_BATCH) break;
    }
    sortLimited = count > rows.length && rows.length >= SORT_SCAN_LIMIT;
    const latestDropByListing = new Map<string, number>();
    for (const event of dropEvents) {
      if (latestDropByListing.has(event.listing_id)) continue;
      const oldPrice = Number(event.old_price_pln);
      const newPrice = Number(event.new_price_pln);
      latestDropByListing.set(event.listing_id, oldPrice > 0 ? (oldPrice - newPrice) / oldPrice : 0);
    }
    rows.sort((left, right) => {
      const dropDifference = (latestDropByListing.get(right.id) ?? -1) - (latestDropByListing.get(left.id) ?? -1);
      if (dropDifference !== 0) return dropDifference;
      return Date.parse(right.first_seen_at) - Date.parse(left.first_seen_at) || right.id.localeCompare(left.id);
    });
    listings = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    count = sortLimited ? rows.length : count;
  } else {
    const result = await listingQuery(supabase, workspaceId, filters)
      .order(sortColumn, { ascending, nullsFirst: false })
      .order("id", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    listings = (result.data ?? []) as ListingRow[];
    count = result.count ?? 0;
    error = result.error;
  }

  const [states, eventResult] = await Promise.all([
    loadListingStates(supabase, workspaceId, listings.map((listing) => listing.id)),
    listings.length
      ? supabase.from("listing_price_events").select("listing_id,old_price_pln,new_price_pln").eq("workspace_id", workspaceId).in("listing_id", listings.map((listing) => listing.id)).order("observed_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [] }),
  ]);
  const dropIds = new Set((eventResult.data ?? []).filter((event) => Number(event.new_price_pln) < Number(event.old_price_pln)).map((event) => event.listing_id));
  const visibleIds = listings.map((listing) => listing.id);
  const [duplicateSourceRows, duplicateCandidateRows] = visibleIds.length
    ? await Promise.all([
        supabase.from("listing_duplicate_candidates").select("id,source_listing_id,candidate_listing_id").eq("workspace_id", workspaceId).eq("resolved_state", "open").in("source_listing_id", visibleIds),
        supabase.from("listing_duplicate_candidates").select("id,source_listing_id,candidate_listing_id").eq("workspace_id", workspaceId).eq("resolved_state", "open").in("candidate_listing_id", visibleIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  const duplicateQueryFailed = Boolean(duplicateSourceRows.error || duplicateCandidateRows.error);
  const duplicateEdges = [...new Map([...(duplicateSourceRows.data ?? []), ...(duplicateCandidateRows.data ?? [])].map((row) => [row.id, row])).values()];
  const counterpartIds = [...new Set(duplicateEdges.flatMap((row) => [row.source_listing_id, row.candidate_listing_id]).filter((id) => !visibleIds.includes(id)))];
  const { data: counterpartListings, error: counterpartError } = counterpartIds.length
    ? await supabase.from("source_listings").select("id,source_key").eq("workspace_id", workspaceId).in("id", counterpartIds)
    : { data: [], error: null };
  const duplicateCounts = new Map<string, Set<string>>();
  const currentSourceById = new Map(listings.map((listing) => [listing.id, listing.source_key]));
  const counterpartSourceById = new Map((counterpartListings ?? []).map((listing) => [listing.id, listing.source_key]));
  for (const edge of duplicateEdges) {
    if (currentSourceById.has(edge.source_listing_id)) {
      const sources = duplicateCounts.get(edge.source_listing_id) ?? new Set([currentSourceById.get(edge.source_listing_id)!]);
      const source = currentSourceById.get(edge.candidate_listing_id) ?? counterpartSourceById.get(edge.candidate_listing_id);
      if (source) sources.add(source);
      duplicateCounts.set(edge.source_listing_id, sources);
    }
    if (currentSourceById.has(edge.candidate_listing_id)) {
      const sources = duplicateCounts.get(edge.candidate_listing_id) ?? new Set([currentSourceById.get(edge.candidate_listing_id)!]);
      const source = currentSourceById.get(edge.source_listing_id) ?? counterpartSourceById.get(edge.source_listing_id);
      if (source) sources.add(source);
      duplicateCounts.set(edge.candidate_listing_id, sources);
    }
  }
  const heading = mode === "favorites" ? "Ulubione" : mode === "contact" ? "Do kontaktu" : "Oferty";
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const queryString = (nextPage: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value && key !== "page") search.set(key, value);
    search.set("page", String(nextPage));
    return `?${search.toString()}`;
  };

  return (
    <AppShell userName={displayName} active={mode === "all" ? "/oferty" : mode === "favorites" ? "/ulubione" : "/do-kontaktu"}>
      <div className="page-heading">
        <div><p className="eyebrow">KATALOG MIESZKAŃ NA SPRZEDAŻ</p><h1>{heading}</h1><p className="page-subtitle">{count} wyników w prywatnej bazie · filtry zapisują się w adresie.</p></div>
        <Link className="button-primary" href="/dodaj"><Plus size={15} /> Dodaj link</Link>
      </div>
      <form className="list-toolbar" action="/oferty" method="get" aria-label="Filtry ofert">
        <input className="field" type="search" name="q" placeholder="Tytuł lub lokalizacja" defaultValue={params.q} aria-label="Szukaj po tytule lub lokalizacji" />
        <select className="select-field" name="profile" defaultValue={selectedProfile?.profile_key ?? ""} aria-label="Profil wyszukiwania"><option value="">Wszystkie oferty</option>{(profiles ?? []).map((profile) => <option value={profile.profile_key} key={profile.id}>{profile.label}</option>)}</select>
        <select className="select-field" name="city" defaultValue={params.city ?? ""} aria-label="Miasto"><option value="">Wszystkie miasta</option><option>Katowice</option><option>Gliwice</option><option>Kraków</option><option>Tychy</option></select>
        <input className="field" name="district" placeholder="Dzielnica" defaultValue={params.district} aria-label="Dzielnica" />
        <select className="select-field" name="source" defaultValue={params.source ?? ""} aria-label="Źródło"><option value="">Wszystkie źródła</option>{Object.entries(sourceLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
        <select className="select-field" name="market" defaultValue={params.market ?? ""} aria-label="Rynek"><option value="">Każdy rynek</option><option value="primary">Pierwotny</option><option value="secondary">Wtórny</option><option value="unknown">Nieustalony</option></select>
        <input className="field" name="minPrice" inputMode="numeric" type="number" min="0" placeholder="Cena od (zł)" defaultValue={params.minPrice} aria-label="Minimalna cena w złotych" />
        <input className="field" name="maxPrice" inputMode="numeric" type="number" min="0" placeholder="Cena do (zł)" defaultValue={params.maxPrice} aria-label="Maksymalna cena w złotych" />
        <input className="field" name="minArea" inputMode="decimal" type="number" min="0" step="0.1" placeholder="Metraż od (m²)" defaultValue={params.minArea} aria-label="Minimalny metraż" />
        <input className="field" name="maxArea" inputMode="decimal" type="number" min="0" step="0.1" placeholder="Metraż do (m²)" defaultValue={params.maxArea} aria-label="Maksymalny metraż" />
        <select className="select-field" name="rooms" defaultValue={params.rooms ?? ""} aria-label="Liczba pokoi"><option value="">Pokoje</option><option value="1">1 pokój</option><option value="2">2 pokoje</option><option value="3">3 pokoje</option><option value="4+">4+ pokoje</option></select>
        <select className="select-field" name="recent" defaultValue={params.recent ?? (params.new === "1" ? "1" : "")} aria-label="Nowe oferty"><option value="">Dowolna data dodania</option><option value="1">Nowe · 24 godziny</option><option value="3">Nowe · 3 dni</option><option value="7">Nowe · 7 dni</option><option value="30">Nowe · 30 dni</option></select>
        <select className="select-field" name="review" defaultValue={params.review ?? ""} aria-label="Status przeglądu"><option value="">Każdy status</option><option value="to_review">Nieprzejrzane</option><option value="interesting">Interesujące</option><option value="to_contact">Do kontaktu</option><option value="contacted">Kontaktowano</option><option value="to_view">Do obejrzenia</option><option value="rejected">Odrzucone</option><option value="archived">Archiwum użytkownika</option></select>
        <select className="select-field" name="lifecycle" defaultValue={params.lifecycle ?? "active"} aria-label="Stan oferty"><option value="active">Aktywne</option><option value="potentially_stale">Niepotwierdzone</option><option value="gone">Usunięte u źródła</option><option value="archived">Archiwalne</option><option value="">Wszystkie stany</option></select>
        <select className="select-field" name="priceDrop" defaultValue={params.priceDrop ?? ""} aria-label="Zmiana ceny"><option value="">Każda zmiana ceny</option><option value="1">Obniżka · 30 dni</option></select>
        <select className="select-field" name="hasImage" defaultValue={params.hasImage ?? ""} aria-label="Zdjęcie"><option value="">Zdjęcie dowolne</option><option value="1">Tylko ze zdjęciem</option></select>
        <select className="select-field" name="sort" defaultValue={sort} aria-label="Sortowanie"><option value="newest">Ostatnio wykryte</option><option value="published">Najnowsze u portalu</option><option value="price_asc">Cena rosnąco</option><option value="price_desc">Cena malejąco</option><option value="price_m2_asc">Cena / m² rosnąco</option><option value="price_m2_desc">Cena / m² malejąco</option><option value="area_desc">Największy metraż</option><option value="area_asc">Najmniejszy metraż</option><option value="drop_desc">Największa obniżka</option></select>
        <button className="button-secondary" type="submit"><Search size={14} /> Filtruj</button>
        <Link className="button-secondary" href="/oferty" aria-label="Wyczyść filtry"><X size={14} /> Wyczyść</Link>
      </form>
      {Boolean(error) && <div className="source-alert" role="alert">Nie udało się pobrać ofert. Sprawdź połączenie z lokalną bazą.</div>}
      {dropEventsError && (params.priceDrop === "1" || sort === "drop_desc") && <div className="source-alert" role="alert">Nie udało się odczytać historii obniżek; wybierz inne sortowanie albo spróbuj ponownie.</div>}
      {sortLimited && <div className="disclaimer" role="status">Sortowanie obniżek obejmuje pierwsze {SORT_SCAN_LIMIT.toLocaleString("pl-PL")} pasujących ofert. Zawęź filtry, aby posortować cały wynik.</div>}
      {duplicateQueryFailed || Boolean(counterpartError) ? <div className="source-alert" role="alert">Nie udało się sprawdzić podobnych ofert.</div> : null}
      {listings.length ? <div className="listing-grid">{listings.map((listing) => <ListingCard key={listing.id} listing={listing} state={states.get(listing.id)} priceDrop={dropIds.has(listing.id)} duplicateSourceCount={duplicateCounts.get(listing.id)?.size} />)}</div> : <div className="panel"><div className="empty-state"><strong>{count === 0 && (mode === "favorites" ? "Nie masz jeszcze ulubionych" : mode === "contact" ? "Brak ofert do kontaktu" : "Brak wyników")}</strong>{count === 0 && mode === "all" ? "Zmień filtry lub sprawdź źródła. Ręcznie dodane i zsynchronizowane oferty pojawią się w tej bazie." : "Oznacz ofertę gwiazdką lub zmień jej status, aby dodać ją do tego widoku."}<div style={{ marginTop: 14 }}><Link className="button-secondary" href="/zrodla">Sprawdź źródła</Link></div></div></div>}
      {totalPages > 1 && <nav className="pagination" aria-label="Paginacja">{page > 1 && <Link className="page-number" href={queryString(page - 1)}>Wstecz</Link>}<span className="page-number current" aria-current="page">{page} / {totalPages}</span>{page < totalPages && <Link className="page-number" href={queryString(page + 1)}>Dalej</Link>}</nav>}
    </AppShell>
  );
}
