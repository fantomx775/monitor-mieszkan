import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

async function main() {
  const supabase = createSupabaseAdminClient();
  const { data: workspace, error: workspaceError } = await supabase.from("workspaces").select("id,name,timezone").eq("id", "00000000-0000-4000-8000-000000000001").maybeSingle();
  if (workspaceError || !workspace) throw new Error("No local workspace is configured.");
  const generatedAt = new Date().toISOString();
  const reportDate = new Intl.DateTimeFormat("en-CA", { timeZone: workspace.timezone }).format(new Date(generatedAt));
  const { data: previousReport, error: previousReportError } = await supabase
    .from("daily_reports")
    .select("period_end,generated_at")
    .eq("workspace_id", workspace.id)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previousReportError) throw new Error("Could not determine the previous successful report session.");
  const baseline = !previousReport;
  const start = previousReport?.period_end ?? generatedAt;
  const end = generatedAt;
  const { data: completedRuns, error: runsError } = await supabase
    .from("sync_runs")
    .select("id,status,started_at,finished_at,total_new,total_updated,total_unchanged,total_errors")
    .eq("workspace_id", workspace.id)
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(2);
  if (runsError) throw new Error("Could not read successful local sync runs.");
  const latest = completedRuns?.[0] ?? null;
  const { data: latestSuccessfulRun, error: successfulRunError } = await supabase
    .from("sync_runs")
    .select("id,status,started_at,finished_at,total_new,total_updated,total_unchanged,total_errors")
    .eq("workspace_id", workspace.id)
    .eq("status", "success")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (successfulRunError) throw new Error("Could not read the latest successful local sync run.");
  /*
   * Report deltas are based on the previous persisted report checkpoint.
   * Sync runs continue to provide health context, but do not move this window.
   */
  const [newRows, priceEvents, sources, latestRuns] = await Promise.all([
    !baseline
      ? supabase.from("source_listings").select("id,title,source_key,canonical_url,city,district,price_pln,first_seen_at").eq("workspace_id", workspace.id).gt("first_seen_at", start).lte("first_seen_at", end).order("first_seen_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [], error: null }),
    !baseline
      ? supabase.from("listing_price_events").select("id,listing_id,old_price_pln,new_price_pln,observed_at").eq("workspace_id", workspace.id).gt("observed_at", start).lte("observed_at", end).order("observed_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("sources").select("source_key,name,access_status,enabled,access_note").eq("workspace_id", workspace.id).order("name"),
    supabase.from("sync_runs").select("id,status,started_at,finished_at,total_new,total_updated,total_errors").eq("workspace_id", workspace.id).order("started_at", { ascending: false }).limit(1),
  ]);
  if (newRows.error || priceEvents.error || sources.error || latestRuns.error) {
    throw new Error("Could not read local data for the daily report; no checkpoint was saved.");
  }
  const reductions = (priceEvents.data ?? []).filter((event) => Number(event.new_price_pln) < Number(event.old_price_pln));
  const sourceData = sources.data ?? [];
  const sourceNames = new Map(sourceData.map((source) => [source.source_key, source.name]));
  const listingIds = [...new Set(reductions.map((event) => event.listing_id))];
  const { data: reductionListings, error: reductionListingsError } = listingIds.length
    ? await supabase.from("source_listings").select("id,title,source_key,canonical_url,city,district").eq("workspace_id", workspace.id).in("id", listingIds)
    : { data: [], error: null };
  if (reductionListingsError) throw new Error("Could not read listings for daily price reductions; no checkpoint was saved.");
  const reductionMap = new Map((reductionListings ?? []).map((listing) => [listing.id, listing]));
  const report = {
    workspace: workspace.name,
    generatedAt,
    timezone: workspace.timezone,
    baseline,
    periodStart: baseline ? null : start,
    periodEnd: end,
    latestCompletedRun: latest,
    latestSuccessfulRun,
    latestAttempt: latestRuns.data?.[0] ?? null,
    newListings: newRows.data ?? [],
    priceReductions: reductions.map((event) => ({ ...event, listing: reductionMap.get(event.listing_id) ?? null })),
    sources: sourceData,
  };

  const outputDir = path.resolve(process.cwd(), "artifacts", "reports");
  await mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `daily-${reportDate}.json`);
  const markdownPath = path.join(outputDir, `daily-${reportDate}.md`);
  const markdown = [
    `# Raport poranny — ${reportDate}`,
    "",
    `- Wygenerowano: ${new Date().toISOString()}`,
    `- Zakres: ${report.baseline ? "pierwszy raport — baza początkowa" : `${report.periodStart} → ${report.periodEnd}`}`,
    `- Ostatni pełny sukces: ${latestSuccessfulRun?.finished_at ?? "brak"}`,
    `- Ostatnia ukończona synchronizacja: ${latest?.finished_at ?? "brak"} (${latest?.status ?? "—"})`,
    `- Ostatnia próba: ${latestRuns.data?.[0]?.started_at ?? "brak"} (${latestRuns.data?.[0]?.status ?? "—"})`,
    `- Nowe oferty: ${report.newListings.length}${report.baseline ? " (pierwszy import — baza początkowa)" : ""}`,
    `- Obniżki cen: ${report.priceReductions.length}`,
    "",
    "## Nowe w lokalnej bazie",
    ...(report.newListings.length ? report.newListings.map((listing) => `- ${listing.title || "Mieszkanie"} · ${[listing.district, listing.city].filter(Boolean).join(", ") || "lokalizacja niepodana"} · ${sourceNames.get(listing.source_key) ?? listing.source_key} · ${listing.price_pln ? `${Number(listing.price_pln).toLocaleString("pl-PL")} zł` : "cena niepodana"} · [oryginał](${listing.canonical_url})`) : ["- Brak nowych pozycji w tym okresie."]),
    "",
    "## Obniżki",
    ...(report.priceReductions.length ? report.priceReductions.map((event) => `- ${event.listing?.title || "Mieszkanie"} · ${sourceNames.get(event.listing?.source_key ?? "") ?? event.listing?.source_key ?? ""} · ${Number(event.old_price_pln).toLocaleString("pl-PL")} zł → ${Number(event.new_price_pln).toLocaleString("pl-PL")} zł`) : ["- Brak zarejestrowanych obniżek."]),
    "",
    "## Źródła",
    ...(report.sources.map((source) => `- ${source.name}: ${source.access_status}${source.enabled ? " (aktywne)" : " (wyłączone)"}${source.access_note ? ` — ${source.access_note}` : ""}`)),
    "",
    "Raport zawiera wyłącznie dane z lokalnej bazy. Nie wysłano powiadomień.",
  ].join("\n");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${markdown}\n`, "utf8");
  const { error: checkpointError } = await supabase.from("daily_reports").insert({
    workspace_id: workspace.id,
    period_start: start,
    period_end: end,
    generated_at: generatedAt,
    baseline,
    new_listing_count: report.newListings.length,
    price_reduction_count: report.priceReductions.length,
    payload_json: {
      latest_sync_status: latest?.status ?? null,
      latest_successful_sync_at: latestSuccessfulRun?.finished_at ?? null,
      source_count: sourceData.length,
    },
  });
  if (checkpointError) throw new Error("Could not save the daily report checkpoint.");
  console.log(JSON.stringify({ status: "written", date: reportDate, newListings: report.newListings.length, priceReductions: report.priceReductions.length, files: [path.relative(process.cwd(), jsonPath), path.relative(process.cwd(), markdownPath)] }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Daily report generation failed.");
  process.exitCode = 1;
});
