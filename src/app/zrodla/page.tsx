import Link from "next/link";
import { ArrowRight, CircleHelp, Radio } from "lucide-react";
import { AppShell } from "@/app/_components/app-shell";
import { dateTime, requireWorkspace } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const { supabase, workspaceId, displayName } = await requireWorkspace();
  const [{ data: sources, error }, { data: runs }] = await Promise.all([
    supabase.from("sources").select("source_key,name,base_url,enabled,collection_mode,access_status,access_note,access_checked_at,last_live_pass_at").eq("workspace_id", workspaceId).order("name"),
    supabase.from("sync_source_runs").select("source_key,status,found_count,inserted_count,updated_count,finished_at,error_kind,error_message").eq("workspace_id", workspaceId).order("started_at", { ascending: false }).limit(100),
  ]);
  const latestBySource = new Map<string, NonNullable<typeof runs>[number]>();
  for (const run of runs ?? []) if (!latestBySource.has(run.source_key)) latestBySource.set(run.source_key, run);
  const statusLabel: Record<string, string> = {
    LIVE_PASS: "Live pass",
    LIVE_PARTIAL: "Częściowy live",
    FIXTURE_ONLY: "Tylko fixture",
    BLOCKED_BY_ACCESS_OR_POLICY: "Zablokowane",
    FAILED: "Błąd",
    NOT_TESTED: "Nie testowano",
  };

  return <AppShell userName={displayName} active="/zrodla">
    <div className="page-heading"><div><p className="eyebrow">DOSTĘP I HISTORIA PRZEBIEGÓW</p><h1>Źródła</h1><p className="page-subtitle">Statusy odnoszą się do lokalnie sprawdzonych adapterów. Błąd źródła nie jest pustym wynikiem.</p></div><Link className="button-secondary" href="/oferty"><ArrowRight size={14} /> Katalog ofert</Link></div>
    {error && <div className="source-alert">Nie udało się odczytać rejestru źródeł z bazy.</div>}
    <section className="panel">
      <div className="panel-header"><div><h2>Rejestr portali</h2><small>{sources?.length ?? 0} źródeł · bez integracji partnerskich</small></div><Radio size={16} color="#578474" /></div>
      <div className="source-list">{(sources ?? []).map((source) => {
        const last = latestBySource.get(source.source_key);
        const status = source.access_status;
        const chip = status === "LIVE_PASS" ? "status-chip live" : status === "BLOCKED_BY_ACCESS_OR_POLICY" || status === "FAILED" ? "status-chip blocked" : "status-chip";
        return <article className="source-row" key={source.source_key}>
          <div className="source-name"><span className="source-symbol"><Radio size={14} /></span>{source.name}</div>
          <span className={chip}>{statusLabel[status] ?? status}</span>
          <span className="source-mode">{source.enabled ? `Aktywne · ${source.collection_mode}` : `Wyłączone · ${source.collection_mode}`}</span>
          <span className="source-last">{last ? `${last.status} · ${dateTime(last.finished_at)}` : `Ostatnia próba: brak`}</span>
          {source.access_note && <div className="source-last" style={{ gridColumn: "1 / -1", paddingLeft: 36, lineHeight: 1.5 }}>{source.access_note}{source.access_checked_at ? ` · sprawdzono ${dateTime(source.access_checked_at)}` : ""}</div>}
          {last?.error_message && <div className="source-alert" style={{ gridColumn: "1 / -1", marginTop: 0 }}><strong>{last.error_kind ?? "Błąd synchronizacji"}</strong>{last.error_message}</div>}
        </article>;
      })}</div>
    </section>
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="panel-header"><div><h2>Ostatnie synchronizacje</h2><small>Przebiegi zapisane w lokalnej bazie</small></div><CircleHelp size={16} color="#82958b" /></div>
      {(runs ?? []).length ? <div className="table-wrap"><table className="profile-table"><thead><tr><th>Źródło</th><th>Wynik</th><th>Oferty</th><th>Nowe / zmienione</th><th>Czas</th></tr></thead><tbody>{runs?.slice(0, 30).map((run, index) => <tr key={`${run.source_key}-${run.finished_at}-${index}`}><td>{sources?.find((source) => source.source_key === run.source_key)?.name ?? run.source_key}</td><td>{run.status}</td><td>{run.found_count}</td><td>{run.inserted_count} / {run.updated_count}</td><td>{dateTime(run.finished_at)}</td></tr>)}</tbody></table></div> : <div className="empty-state"><strong>Brak przebiegów</strong>Uruchom lokalne `pnpm sync`, gdy dostępne adaptery są gotowe.</div>}
    </section>
  </AppShell>;
}
