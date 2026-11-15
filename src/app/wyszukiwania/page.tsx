import Link from "next/link";
import { updateSearchProfile } from "@/app/actions";
import { AppShell } from "@/app/_components/app-shell";
import { requireWorkspace } from "@/lib/data";

export const dynamic = "force-dynamic";

function otodomUrlFromFilters(filters: unknown): string {
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return "";
  const url = (filters as Record<string, unknown>).otodom_search_url;
  return typeof url === "string" ? url : "";
}

function olxUrlFromFilters(filters: unknown): string {
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return "";
  const url = (filters as Record<string, unknown>).olx_search_url;
  return typeof url === "string" ? url : "";
}

function adresowoUrlFromFilters(filters: unknown): string {
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return "";
  const url = (filters as Record<string, unknown>).adresowo_search_url;
  return typeof url === "string" ? url : "";
}

function olxParamsFromFilters(filters: unknown): Record<string, unknown> {
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return {};
  const value = (filters as Record<string, unknown>).olx_search_params;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export default async function ProfilesPage() {
  const { supabase, workspaceId, displayName } = await requireWorkspace();
  const [{ data: profiles }, { data: sources }] = await Promise.all([
    supabase.from("search_profiles").select("id,label,profile_key,enabled,city,preferred_districts,price_max_pln,area_min_m2,area_max_m2,preferred_rooms,mode,sources,filters").eq("workspace_id", workspaceId).order("city"),
    supabase.from("sources").select("source_key,name,access_status,enabled").eq("workspace_id", workspaceId),
  ]);
  return <AppShell userName={displayName} active="/wyszukiwania">
    <div className="page-heading"><div><p className="eyebrow">EDYTOWALNE KRYTERIA</p><h1>Wyszukiwania</h1><p className="page-subtitle">Początkowe profile są wczytywane z bazy i nie są twardą prognozą opłacalności.</p></div><Link href="/zrodla" className="button-secondary">Dostęp źródeł</Link></div>
    <div style={{ display: "grid", gap: 11 }}>{(profiles ?? []).map((profile) => <section className="panel profile-card" key={profile.id}>
      <div className="profile-summary"><div><h2>{profile.label}</h2><p>{profile.city} · {profile.preferred_districts?.length ? profile.preferred_districts.join(", ") : "bez preferowanych dzielnic"}</p></div><span className={`status-chip ${profile.enabled ? "live" : ""}`}>{profile.enabled ? "Aktywny" : "Wyłączony"}</span></div>
      <div className="profile-summary-facts"><span>Do {profile.price_max_pln?.toLocaleString("pl-PL") ?? "bez limitu"} zł</span><span>{profile.area_min_m2 ?? "—"}–{profile.area_max_m2 ?? "—"} m²</span><span>{profile.preferred_rooms?.join(", ") || "Dowolna liczba"} pok.</span><span>{profile.mode === "discovery" ? "Szeroki dobór" : "Ścisłe kryteria"}</span></div>
      <details className="profile-edit"><summary>Edytuj kryteria i źródła</summary>
        <form action={updateSearchProfile.bind(null, profile.id)} className="stack-form" style={{ marginTop: 14 }}>
          <div className="form-grid"><label>Nazwa profilu<input className="field" name="label" defaultValue={profile.label} required maxLength={160} /></label><label>Miasto<input className="field" name="city" defaultValue={profile.city} required maxLength={160} /></label></div>
          <label>Preferowane dzielnice<input className="field" name="preferred_districts" defaultValue={profile.preferred_districts?.join(", ")} placeholder="Dzielnice oddziel przecinkami" /></label>
          <label>Link do wyników Otodom<input className="field" name="otodom_search_url" type="url" maxLength={2048} defaultValue={otodomUrlFromFilters(profile.filters)} placeholder="https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/..." /></label>
          <p className="disclaimer">Wklej link do strony wyników sprzedaży mieszkań z wybranymi filtrami. Synchronizacja czyta wyłącznie listę wyników, bez szczegółów i zdjęć.</p>
          <label>Link do wyników OLX<input className="field" name="olx_search_url" type="url" maxLength={2048} defaultValue={olxUrlFromFilters(profile.filters)} placeholder="https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/..." /></label>
          <details><summary>Zaawansowane parametry OLX</summary>
            <p className="disclaimer">Wymagane są identyfikatory kategorii i lokalizacji; przechwycone wartości są już zapisane w profilu.</p>
            <div className="form-grid"><label>OLX category_id<input className="field" name="olx_category_id" type="number" min="1" step="1" defaultValue={String(olxParamsFromFilters(profile.filters).categoryId ?? "")} /></label><label>OLX region_id<input className="field" name="olx_region_id" type="number" min="1" step="1" defaultValue={String(olxParamsFromFilters(profile.filters).regionId ?? "")} /></label></div>
            <div className="form-grid"><label>OLX city_id<input className="field" name="olx_city_id" type="number" min="1" step="1" defaultValue={String(olxParamsFromFilters(profile.filters).cityId ?? "")} /></label><label>OLX query<input className="field" name="olx_query" maxLength={200} defaultValue={String(olxParamsFromFilters(profile.filters).query ?? "")} /></label></div>
            <div className="form-grid"><label>OLX suggest_filters<input className="field" name="olx_suggest_filters" maxLength={40} defaultValue={String(olxParamsFromFilters(profile.filters).suggestFilters ?? "true")} /></label><label>OLX sl (opcjonalnie)<input className="field" name="olx_sl" maxLength={120} defaultValue={String(olxParamsFromFilters(profile.filters).sl ?? "")} /></label></div>
          </details>
          <label>Link do wyników Adresowo<input className="field" name="adresowo_search_url" type="url" maxLength={2048} defaultValue={adresowoUrlFromFilters(profile.filters)} placeholder="https://adresowo.pl/f/mieszkania/..." /></label>
          <div className="form-grid"><label>Maksymalna cena (zł)<input className="field" name="price_max_pln" type="number" min="1" defaultValue={profile.price_max_pln ?? ""} /></label><label>Pokoje<input className="field" name="preferred_rooms" defaultValue={profile.preferred_rooms?.join(", ")} placeholder="np. 2, 3" /></label></div>
          <div className="form-grid"><label>Metraż od (m²)<input className="field" name="area_min_m2" type="number" min="0.1" step="0.1" defaultValue={profile.area_min_m2 ?? ""} /></label><label>Metraż do (m²)<input className="field" name="area_max_m2" type="number" min="0.1" step="0.1" defaultValue={profile.area_max_m2 ?? ""} /></label></div>
          <label>Tryb<select className="select-field" name="mode" defaultValue={profile.mode}><option value="discovery">Szeroki dobór</option><option value="strict">Ścisłe kryteria</option></select></label>
          <div className="source-checks"><strong>Uwzględniane źródła</strong>{(sources ?? []).filter((source) => source.source_key !== "manual").map((source) => <label key={source.source_key}><input type="checkbox" name="sources" value={source.source_key} defaultChecked={profile.sources?.includes(source.source_key)} /> {source.name} <small>{source.access_status === "BLOCKED_BY_ACCESS_OR_POLICY" ? "zablokowane" : source.enabled ? "aktywne" : "wyłączone"}</small></label>)}</div>
          <label className="checkbox-line"><input type="checkbox" name="enabled" defaultChecked={profile.enabled} /> Wyszukiwanie aktywne</label>
          <button className="button-primary" type="submit">Zapisz profil</button>
        </form>
      </details>
    </section>)}{!profiles?.length && <section className="panel"><div className="empty-state"><strong>Brak profili</strong>Dodaj profil wyszukiwania do workspace.</div></section>}</div>
    <p className="disclaimer" style={{ marginTop: 13 }}>Profile startowe: Katowice, Gliwice, Kraków i Tychy. Kryteria są preferencjami użytkownika; tryb szeroki zachowuje wartościowe wyjątki.</p>
  </AppShell>;
}
