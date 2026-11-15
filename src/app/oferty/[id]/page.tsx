import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Heart, MapPin } from "lucide-react";
import { addNote, resolveDuplicateCandidate, saveInvestmentInputs, setReviewStatus, toggleFavorite } from "@/app/actions";
import { AppShell } from "@/app/_components/app-shell";
import { dateTime, pln, reviewLabels, sourceLabels, requireWorkspace, type ListingRow } from "@/lib/data";
import { canonicalizeListingUrl } from "@/lib/sources/normalization";
import { SourceKeySchema } from "@/lib/sources/contracts";

export const dynamic = "force-dynamic";

export default async function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, workspaceId, userId, displayName } = await requireWorkspace();
  const [
    { data: rawListing },
    { data: notes },
    { data: events },
    { data: stateRows },
    { data: sourceSideCandidates, error: sourceSideError },
    { data: candidateSideCandidates, error: candidateSideError },
    { data: fieldEvents, error: fieldEventsError },
  ] = await Promise.all([
    supabase.from("source_listings").select("id,source_key,external_id,canonical_url,title,market,price_pln,area_m2,rooms,floor,city,district,street,published_at,first_seen_at,last_seen_at,last_checked_at,life_cycle,source_evidence,image_original_url,expected_rent_pln,admin_fees_pln,renovation_cost_pln,acquisition_cost_pln").eq("workspace_id", workspaceId).eq("id", id).maybeSingle(),
    supabase.from("listing_notes").select("id,author_id,body,created_at").eq("workspace_id", workspaceId).eq("listing_id", id).order("created_at", { ascending: false }).limit(50),
    supabase.from("listing_price_events").select("id,old_price_pln,new_price_pln,observed_at").eq("workspace_id", workspaceId).eq("listing_id", id).order("observed_at", { ascending: false }).limit(50),
    supabase.from("listing_user_state").select("listing_id,favorite,review_status,reviewed_at,viewing_scheduled_at,updated_at").eq("workspace_id", workspaceId).eq("listing_id", id).maybeSingle(),
    supabase.from("listing_duplicate_candidates").select("id,source_listing_id,candidate_listing_id,confidence,resolved_state,created_at").eq("workspace_id", workspaceId).eq("source_listing_id", id).order("created_at", { ascending: false }).limit(100),
    supabase.from("listing_duplicate_candidates").select("id,source_listing_id,candidate_listing_id,confidence,resolved_state,created_at").eq("workspace_id", workspaceId).eq("candidate_listing_id", id).order("created_at", { ascending: false }).limit(100),
    supabase.from("listing_field_events").select("id,actor_id,field_key,old_value,new_value,observed_at").eq("workspace_id", workspaceId).eq("listing_id", id).in("field_key", ["expected_rent_pln", "admin_fees_pln", "renovation_cost_pln", "acquisition_cost_pln"]).order("observed_at", { ascending: false }).limit(20),
  ]);
  if (!rawListing) notFound();
  const listing = rawListing as ListingRow & {
    expected_rent_pln: number | null;
    admin_fees_pln: number | null;
    renovation_cost_pln: number | null;
    acquisition_cost_pln: number | null;
  };
  const state = stateRows;
  const pricePerM2 = listing.price_pln != null && listing.area_m2 ? listing.price_pln / listing.area_m2 : null;
  const duplicateCandidates = [...new Map([...(sourceSideCandidates ?? []), ...(candidateSideCandidates ?? [])].map((candidate) => [candidate.id, candidate])).values()];
  const counterpartIds = [...new Set(duplicateCandidates.map((candidate) => candidate.source_listing_id === listing.id ? candidate.candidate_listing_id : candidate.source_listing_id))];
  const { data: counterpartRows, error: counterpartsError } = counterpartIds.length
    ? await supabase.from("source_listings").select("id,source_key,canonical_url,title,price_pln,area_m2,rooms,city,district").eq("workspace_id", workspaceId).in("id", counterpartIds)
    : { data: [], error: null };
  const counterpartById = new Map((counterpartRows ?? []).map((counterpart) => [counterpart.id, counterpart]));
  const duplicateCandidatesError = Boolean(sourceSideError || candidateSideError || counterpartsError);
  const duplicateStatusLabels: Record<string, string> = {
    open: "Do sprawdzenia",
    confirmed: "Potwierdzono tę samą ofertę",
    rejected: "Odrzucono podobieństwo",
    linked: "Powiązano ręcznie",
  };
  const investmentCostBase = (listing.acquisition_cost_pln ?? 0) + (listing.renovation_cost_pln ?? 0);
  const grossYieldPercent = listing.expected_rent_pln != null && listing.acquisition_cost_pln != null && investmentCostBase > 0
    ? (listing.expected_rent_pln * 12 / investmentCostBase) * 100
    : null;
  const investmentFieldLabels: Record<string, string> = {
    expected_rent_pln: "Oczekiwany czynsz miesięczny",
    admin_fees_pln: "Czynsz administracyjny miesięczny",
    renovation_cost_pln: "Koszt remontu",
    acquisition_cost_pln: "Szacunkowy koszt zakupu",
  };

  return (
    <AppShell userName={displayName} active="/oferty">
      <div className="page-heading">
        <div><Link href="/oferty" className="panel-link"><ArrowLeft size={13} /> Wróć do ofert</Link><p className="eyebrow" style={{ marginTop: 17 }}>SZCZEGÓŁY OGŁOSZENIA · {sourceLabels[listing.source_key] ?? listing.source_key}</p><h1>{listing.title || "Mieszkanie na sprzedaż"}</h1><p className="page-subtitle"><MapPin size={13} style={{ verticalAlign: "-2px" }} /> {[listing.street, listing.district, listing.city].filter(Boolean).join(", ") || "Lokalizacja do uzupełnienia"}</p></div>
        <div className="quick-actions" style={{ margin: 0 }}><form action={toggleFavorite.bind(null, listing.id)}><button className="button-secondary" type="submit" aria-label={state?.favorite ? "Usuń z ulubionych" : "Dodaj do ulubionych"}><Heart size={15} fill={state?.favorite ? "currentColor" : "none"} /> {state?.favorite ? "Ulubiona" : "Dodaj do ulubionych"}</button></form><a className="button-primary" href={listing.canonical_url} target="_blank" rel="noreferrer">Otwórz oryginał <ArrowUpRight size={14} /></a></div>
      </div>
      <div className="detail-layout">
        <div className="detail-card">
          <div className="listing-image" style={{ minHeight: 250, borderRadius: 8 }}><span className="image-icon">⌂</span><span className="image-caption">BRAK ZAPISANEJ MINIATURY</span></div>
          <div className="detail-title">{listing.title || "Mieszkanie na sprzedaż"}</div>
          <div className="detail-price">{pln(listing.price_pln)}</div>
          <div className="detail-facts">
            <Fact label="Powierzchnia" value={listing.area_m2 == null ? "—" : `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(listing.area_m2)} m²`} />
            <Fact label="Pokoje" value={listing.rooms == null ? "—" : String(listing.rooms)} />
            <Fact label="Cena / m²" value={pricePerM2 == null ? "—" : `${Math.round(pricePerM2).toLocaleString("pl-PL")} zł`} />
          </div>
          <Line label="Rynek" value={listing.market === "primary" ? "Pierwotny" : listing.market === "secondary" ? "Wtórny" : "Nieustalony"} />
          <Line label="Piętro" value={listing.floor == null ? "Niepodane" : String(listing.floor)} />
          <Line label="Źródło danych" value={`${sourceLabels[listing.source_key] ?? listing.source_key} · ${listing.source_evidence}`} />
          <Line label="Wykryto w bazie" value={dateTime(listing.first_seen_at)} />
          <Line label="Ostatnio widziano" value={dateTime(listing.last_seen_at)} />
          <Line label="Ostatnio sprawdzono" value={dateTime(listing.last_checked_at)} />
          <Line label="Data podana przez portal" value={dateTime(listing.published_at)} />
        </div>
        <div style={{ display: "grid", gap: 13 }}>
          <section className="detail-card">
            <h2 className="section-title">Status decyzji</h2>
            <form action={setReviewStatus.bind(null, listing.id)} className="stack-form">
              <label>Status<select className="select-field" name="status" defaultValue={state?.review_status ?? "to_review"}>{Object.entries(reviewLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
              <button className="button-primary" type="submit">Zapisz status</button>
            </form>
            <div style={{ marginTop: 13 }} className="disclaimer">Statusy i notatki są przypisane do workspace i pozostają przy kolejnych synchronizacjach.</div>
          </section>
          <section className="detail-card">
            <h2 className="section-title">Historia cen</h2>
            {events?.length ? events.map((event) => <div className="price-event" key={event.id}><span>{dateTime(event.observed_at)}</span><strong>{pln(Number(event.old_price_pln))} → {pln(Number(event.new_price_pln))}</strong></div>) : <p className="page-subtitle">Brak zarejestrowanych zmian ceny.</p>}
          </section>
          <section className="detail-card">
            <h2 className="section-title">Własne założenia inwestycyjne</h2>
            <form action={saveInvestmentInputs.bind(null, listing.id)} className="stack-form">
              <div className="form-grid">
                <label>Oczekiwany czynsz miesięczny (zł)<input className="field" name="expected_rent_pln" type="number" min="0" max="100000000" step="1" defaultValue={listing.expected_rent_pln ?? ""} /></label>
                <label>Czynsz administracyjny miesięczny (zł)<input className="field" name="admin_fees_pln" type="number" min="0" max="100000000" step="1" defaultValue={listing.admin_fees_pln ?? ""} /></label>
                <label>Koszt remontu (zł)<input className="field" name="renovation_cost_pln" type="number" min="0" max="100000000" step="1" defaultValue={listing.renovation_cost_pln ?? ""} /></label>
                <label>Szacunkowy koszt zakupu (zł)<input className="field" name="acquisition_cost_pln" type="number" min="0" max="100000000" step="1" defaultValue={listing.acquisition_cost_pln ?? ""} /></label>
              </div>
              <button className="button-primary" type="submit">Zapisz założenia</button>
            </form>
            <div className="detail-line" style={{ marginTop: 14 }}><span>Roczny przychód brutto / zakup z remontem</span><strong>{grossYieldPercent == null ? "Uzupełnij czynsz i koszt zakupu" : `${grossYieldPercent.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`}</strong></div>
            <p className="disclaimer" style={{ marginTop: 9 }}>Wskaźnik = czynsz miesięczny × 12 ÷ (koszt zakupu + koszt remontu; brak remontu przyjęto jako 0). To wartość brutto; nie odejmuje opłat administracyjnych, podatków, pustostanu ani kosztów finansowania. Nie jest prognozą zysku netto.</p>
            {fieldEventsError && <div className="source-alert" role="alert">Nie udało się odczytać historii własnych założeń.</div>}
            {fieldEvents?.length ? <div style={{ marginTop: 12 }}><strong>Historia zmian</strong>{fieldEvents.map((event) => <div className="price-event" key={event.id}><span>{investmentFieldLabels[event.field_key] ?? event.field_key} · {event.actor_id === userId ? displayName : "Współużytkownik"} · {dateTime(event.observed_at)}</span><strong>{event.old_value == null ? "—" : pln(Number(event.old_value))} → {event.new_value == null ? "—" : pln(Number(event.new_value))}</strong></div>)}</div> : null}
          </section>
          <section className="detail-card">
            <h2 className="section-title">Podobne oferty z innych portali</h2>
            <p className="page-subtitle">Podobieństwo jest kandydatem do ręcznej oceny. Potwierdzenie zapisze powiązanie tej pary; rekordy i ich historie pozostają oddzielne.</p>
            {duplicateCandidatesError && <div className="source-alert" role="alert">Nie udało się odczytać powiązanych kandydatów.</div>}
            {duplicateCandidates.length ? <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              {duplicateCandidates.map((candidate) => {
                const counterpartId = candidate.source_listing_id === listing.id ? candidate.candidate_listing_id : candidate.source_listing_id;
                const counterpart = counterpartById.get(counterpartId);
                if (!counterpart) return null;
                const safeUrl = safePortalUrl(counterpart.source_key, counterpart.canonical_url);
                return <article className="note-card" key={candidate.id}>
                  <div className="profile-summary">
                    <div><strong>{sourceLabels[counterpart.source_key] ?? counterpart.source_key}</strong><small>{duplicateStatusLabels[candidate.resolved_state] ?? "Status nieznany"} · Wstępny kandydat do ręcznej weryfikacji</small></div>
                  </div>
                  <p style={{ margin: "10px 0 5px", fontWeight: 650 }}>{counterpart.title || "Mieszkanie na sprzedaż"}</p>
                  <small>{[counterpart.district, counterpart.city].filter(Boolean).join(", ") || "Lokalizacja niepodana"} · {pln(counterpart.price_pln)} · {counterpart.area_m2 == null ? "— m²" : `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(counterpart.area_m2)} m²`} · {counterpart.rooms == null ? "— pokoi" : `${counterpart.rooms} pok.`}</small>
                  <div style={{ marginTop: 10 }}>
                    {safeUrl ? <a className="original-link" href={safeUrl} target="_blank" rel="noreferrer">Otwórz oryginał <ArrowUpRight size={14} /></a> : <span className="page-subtitle">Nieprawidłowy link źródłowy — otwarcie wyłączone.</span>}
                  </div>
                  {candidate.resolved_state === "open" && <div className="quick-actions" style={{ marginTop: 12 }}>
                    <form action={resolveDuplicateCandidate.bind(null, candidate.id)}><input type="hidden" name="resolved_state" value="confirmed" /><button className="button-primary" type="submit">To ta sama nieruchomość</button></form>
                    <form action={resolveDuplicateCandidate.bind(null, candidate.id)}><input type="hidden" name="resolved_state" value="rejected" /><button className="button-secondary" type="submit">To inne oferty</button></form>
                  </div>}
                </article>;
              })}
            </div> : !duplicateCandidatesError ? <p className="page-subtitle" style={{ marginTop: 12 }}>Nie wykryto kandydatów z innych portali.</p> : null}
          </section>
          <section className="detail-card">
            <h2 className="section-title">Notatki wspólne</h2>
            <form action={addNote.bind(null, listing.id)} className="stack-form" style={{ marginBottom: 15 }}>
              <label htmlFor="note-body">Dodaj notatkę</label><textarea className="textarea-field" id="note-body" name="body" maxLength={4000} required placeholder="Np. zadzwonić w piątek…" />
              <button className="button-primary" type="submit">Zapisz notatkę</button>
            </form>
            {notes?.length ? notes.map((note) => <div className="note-card" key={note.id}><p>{note.body}</p><small>{note.author_id === userId ? displayName : "Współużytkownik"} · {dateTime(note.created_at)}</small></div>) : <p className="page-subtitle">Nie dodano jeszcze notatek.</p>}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function safePortalUrl(sourceKey: string, url: string) {
  const source = SourceKeySchema.safeParse(sourceKey);
  if (!source.success) return null;
  try {
    return canonicalizeListingUrl(source.data, url);
  } catch {
    return null;
  }
}

function Fact({ label, value }: { label: string; value: string }) { return <div className="detail-fact"><small>{label}</small><strong>{value}</strong></div>; }
function Line({ label, value }: { label: string; value: string }) { return <div className="detail-line"><span>{label}</span><strong>{value}</strong></div>; }
