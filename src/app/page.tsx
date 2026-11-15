import Link from "next/link";
import { ArrowDownRight, ArrowRight, Building2, Heart, Radio, Sparkles } from "lucide-react";
import { AppShell } from "@/app/_components/app-shell";
import { dateTime, pln, requireWorkspace, sourceLabels } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { supabase, workspaceId, displayName } = await requireWorkspace();
  const [activeResult, favoritesResult, contactResult, runResult, lastSuccessResult, reportResult, sourcesResult, profilesResult] = await Promise.all([
    supabase.from("source_listings").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("life_cycle", "active"),
    supabase.from("listing_user_state").select("listing_id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("favorite", true),
    supabase.from("listing_user_state").select("listing_id", { count: "exact", head: true }).eq("workspace_id", workspaceId).in("review_status", ["to_contact", "contacted"]),
    supabase.from("sync_runs").select("id,status,started_at,finished_at,total_new,total_updated,total_errors").eq("workspace_id", workspaceId).order("started_at", { ascending: false }).limit(12),
    supabase.from("sync_runs").select("id,status,started_at,finished_at,total_new,total_updated,total_errors").eq("workspace_id", workspaceId).eq("status", "success").not("finished_at", "is", null).order("finished_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("daily_reports").select("period_end,generated_at").eq("workspace_id", workspaceId).order("generated_at", { ascending: false }).limit(1),
    supabase.from("sources").select("source_key,name,access_status,access_note,enabled,last_live_pass_at").eq("workspace_id", workspaceId).order("name"),
    supabase.from("search_profiles").select("id,profile_key,label,city,enabled").eq("workspace_id", workspaceId).eq("enabled", true),
  ]);
  const runs = runResult.data ?? [];
  const lastAttempt = runs[0];
  const completedRuns = runs.filter((run) => ["success", "partial"].includes(run.status) && run.finished_at);
  const lastSuccess = lastSuccessResult.data;
  const lastReport = reportResult.data?.[0] ?? null;
  const baseline = !lastReport;
  const rangeStart = lastReport?.period_end ?? null;
  const rangeEnd = new Date().toISOString();

  const [newCountResult, unreviewedResult, reductionResult] = await Promise.all([
    rangeStart
      ? supabase.from("source_listings").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).gt("first_seen_at", rangeStart).lte("first_seen_at", rangeEnd)
      : Promise.resolve({ count: 0, data: null }),
    supabase.from("listing_user_state").select("listing_id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("review_status", "to_review"),
    rangeStart
      ? supabase.from("listing_price_events").select("id,listing_id,old_price_pln,new_price_pln,observed_at").eq("workspace_id", workspaceId).gt("observed_at", rangeStart).lte("observed_at", rangeEnd).order("observed_at", { ascending: false }).limit(40)
      : Promise.resolve({ data: [] }),
  ]);
  const reductions = (reductionResult.data ?? []).filter((event) => Number(event.new_price_pln) < Number(event.old_price_pln)).slice(0, 5);
  const listingIds = [...new Set(reductions.map((event) => event.listing_id))];
  const { data: reductionListings } = listingIds.length
    ? await supabase.from("source_listings").select("id,title,source_key,city,district").eq("workspace_id", workspaceId).in("id", listingIds)
    : { data: [] };
  const listingMap = new Map((reductionListings ?? []).map((row) => [row.id, row]));

  const cityCounts = await Promise.all(
    (profilesResult.data ?? []).map(async (profile) => {
      const { count } = await supabase.from("source_listings").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("city", profile.city).eq("life_cycle", "active");
      return { ...profile, count: count ?? 0 };
    }),
  );
  const blockedSources = (sourcesResult.data ?? []).filter((source) => source.access_status === "BLOCKED_BY_ACCESS_OR_POLICY" || source.access_status === "FAILED");
  const today = new Intl.DateTimeFormat("pl-PL", { dateStyle: "full", timeZone: "Europe/Warsaw" }).format(new Date());

  return (
    <AppShell userName={displayName} active="/">
      <div className="page-heading">
        <div><p className="eyebrow">TWÓJ PORANNY PRZEGLĄD</p><h1>Dzień dobry</h1><p className="page-subtitle">Rynek mieszkań w wybranych lokalizacjach. {today}</p></div>
        <Link className="button-primary" href="/oferty?new=1"><Sparkles size={15} /> Przejdź do nowych <ArrowRight size={14} /></Link>
      </div>

      {baseline && lastSuccess && <div className="disclaimer" style={{ marginBottom: 16 }}><strong>Pierwszy raport — baza początkowa.</strong> Nowe pozycje będą liczone od zapisania pierwszego raportu.</div>}

      <section className="metrics-grid" aria-label="Podsumowanie ofert">
        <Metric icon={<Building2 size={16} />} label="Aktywne oferty" value={activeResult.count ?? 0} note="widoczne w prywatnej bazie" />
        <Metric icon={<Sparkles size={16} />} label="Nowe od raportu" value={newCountResult.count ?? 0} note={baseline ? "brak poprzedniego raportu" : "według first_seen_at"} />
        <Metric icon={<Heart size={16} />} label="Ulubione" value={favoritesResult.count ?? 0} note="wspólna krótka lista" />
        <Metric icon={<ArrowDownRight size={16} />} label="Do kontaktu" value={contactResult.count ?? 0} note={`${unreviewedResult.count ?? 0} nieprzejrzanych`} />
      </section>

      <div className="quick-actions">
        <Link href="/oferty?review=to_review" className="button-secondary">Nieprzejrzane <span>{unreviewedResult.count ?? 0}</span></Link>
        <Link href="/ulubione" className="button-secondary">Ulubione <span>{favoritesResult.count ?? 0}</span></Link>
        <Link href="/do-kontaktu" className="button-secondary">Do kontaktu <span>{contactResult.count ?? 0}</span></Link>
        <Link href="/zrodla" className="button-secondary"><Radio size={14} /> Status źródeł</Link>
      </div>

      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-header"><div><h2>Aktywne wyszukiwania</h2><small>Liczba aktywnych ofert w profilu miasta</small></div><Link className="panel-link" href="/wyszukiwania">Zarządzaj</Link></div>
          <div className="panel-body">
            {cityCounts.length ? <div className="city-list">{cityCounts.map((profile) => <div className="city-row" key={profile.id}><div><strong>{profile.city}</strong><small>{profile.label}</small></div><span className="count-bubble">{profile.count}</span></div>)}</div> : <Empty title="Brak profili wyszukiwania" text="Po dodaniu profili zobaczysz tu podsumowanie ofert według miasta." />}
          </div>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Synchronizacje</h2><small>Ostatni pełny sukces i ostatnia próba</small></div><Link className="panel-link" href="/zrodla">Szczegóły</Link></div>
          <div className="panel-body">
            <div className="sync-facts">
              <div className="sync-fact"><span>Ostatni pełny sukces</span><strong>{dateTime(lastSuccess?.finished_at)}</strong></div>
              <div className="sync-fact"><span>Ostatnia próba</span><strong>{lastAttempt ? `${dateTime(lastAttempt.started_at)} · ${lastAttempt.finished_at ? lastAttempt.status : "w trakcie"}` : "Brak przebiegów"}</strong></div>
              {completedRuns[0] && <div className="sync-fact"><span>Nowe / zmienione</span><strong>{completedRuns[0].total_new} / {completedRuns[0].total_updated}</strong></div>}
            </div>
            {lastSuccessResult.error && <div className="source-alert" role="alert">Nie udało się odczytać ostatniego pełnego sukcesu synchronizacji.</div>}
            {blockedSources.slice(0, 2).map((source) => <div className="source-alert" key={source.source_key}><strong>{source.name}: ograniczony dostęp</strong>{source.access_note}</div>)}
          </div>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Ostatnie obniżki</h2><small>Rzeczywista zmiana ceny w źródle</small></div><span className="panel-link">{reductions.length} z 5</span></div>
          <div className="panel-body reduction-list">
            {reductions.length ? reductions.map((event) => {
              const listing = listingMap.get(event.listing_id);
              const oldPrice = Number(event.old_price_pln);
              const newPrice = Number(event.new_price_pln);
              const percent = oldPrice ? Math.round((1 - newPrice / oldPrice) * 100) : 0;
              return <div className="reduction-row" key={event.id}><div><strong>{listing?.title || "Mieszkanie"}</strong><small>{[listing?.district, listing?.city, listing && sourceLabels[listing.source_key]].filter(Boolean).join(" · ")} · {dateTime(event.observed_at)}</small></div><div className="reduction-value">−{percent}%<small>{pln(oldPrice)} → {pln(newPrice)}</small></div></div>;
            }) : <Empty title="Brak zmian cen" text={baseline ? "Zmiany cen pojawią się po kolejnym pełnym imporcie." : "W wybranym zakresie nie ma zarejestrowanych obniżek."} />}
          </div>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Stan źródeł</h2><small>Każde źródło ma osobny status</small></div><Link className="panel-link" href="/zrodla">Wszystkie źródła</Link></div>
          <div className="panel-body">
            <div className="sync-facts">{(sourcesResult.data ?? []).slice(0, 5).map((source) => <div className="sync-fact" key={source.source_key}><span>{source.name}</span><strong className="source-mode">{source.access_status}</strong></div>)}</div>
            {sourcesResult.error && <div className="source-alert">Nie udało się pobrać bieżącego stanu źródeł z bazy.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function Metric({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: number; note: string }) {
  return <div className="metric-card"><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><div className="metric-value">{value.toLocaleString("pl-PL")}</div><div className="metric-foot">{note}</div></div>;
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><strong>{title}</strong>{text}</div>;
}
