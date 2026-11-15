import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { adresowoAdapter } from "@/lib/sources/adresowo/adapter";
import { createDomyAdapter } from "@/lib/sources/domy";
import { domiportaAdapter } from "@/lib/sources/domiporta/adapter";
import { getHomeAdapter } from "@/lib/sources/gethome/adapter";
import { gratkaAdapter } from "@/lib/sources/gratka/adapter";
import { homePortalAdapter } from "@/lib/sources/homeportal/adapter";
import { lentoAdapter } from "@/lib/sources/lento/adapter";
import { MorizonSourceAdapter } from "@/lib/sources/morizon/adapter";
import { nieruchomosciOnlineAdapter } from "@/lib/sources/nieruchomosci-online/adapter";
import { OlxSourceAdapter } from "@/lib/sources/olx/adapter";
import { OtodomSourceAdapter } from "@/lib/sources/otodom/adapter";
import { sprzedajemyAdapter } from "@/lib/sources/sprzedajemy/adapter";
import { tabelaOfertAdapter } from "@/lib/sources/tabelaofert/adapter";
import {
  SearchProfileSchema,
  SourceKeySchema,
  type ScrapeErrorKind,
  type SearchProfile,
  type SourceAdapter,
  type SourceKey,
} from "@/lib/sources/contracts";
import { discoverSafely } from "@/lib/sources/discovery";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Args = {
  source?: SourceKey;
  profile?: string;
  dryRun: boolean;
  maxPages: number;
  since?: string;
  json: boolean;
  verbose: boolean;
};
type Totals = { new: number; updated: number; unchanged: number; errors: number };
type RunStatus = "success" | "partial" | "failed" | "blocked";
const MAX_PAGES_PER_SOURCE = 20;
const MAX_REQUESTS_PER_RUN = 20;
const MAX_REQUESTS_PER_PAGE = 2;
const MAX_RUN_DURATION_MS = 10 * 60 * 1000;

function otodomSearchUrlFromFilters(filters: unknown): string | undefined {
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return undefined;
  const value = (filters as Record<string, unknown>).otodom_search_url;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function olxSearchUrlFromFilters(filters: unknown): string | undefined {
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return undefined;
  const value = (filters as Record<string, unknown>).olx_search_url;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function olxSearchParamsFromFilters(filters: unknown): SearchProfile["olxSearchParams"] {
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return undefined;
  const value = (filters as Record<string, unknown>).olx_search_params;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const params = value as Record<string, unknown>;
  const categoryId = Number(params.categoryId);
  const regionId = Number(params.regionId);
  const cityId = Number(params.cityId);
  if (![categoryId, regionId, cityId].every((id) => Number.isSafeInteger(id) && id > 0)) return undefined;
  return {
    categoryId,
    regionId,
    cityId,
    query: typeof params.query === "string" ? params.query : undefined,
    suggestFilters: typeof params.suggestFilters === "string" ? params.suggestFilters : undefined,
    sl: typeof params.sl === "string" ? params.sl : undefined,
  };
}

function adresowoSearchUrlFromFilters(filters: unknown): string | undefined {
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return undefined;
  const value = (filters as Record<string, unknown>).adresowo_search_url;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseArgs(argv: string[]): Args {
  const result: Args = { dryRun: false, maxPages: 1, json: false, verbose: false };
  while (argv[0] === "--") argv.shift();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      const parsed = SourceKeySchema.safeParse(argv[++index]);
      if (!parsed.success || parsed.data === "manual") throw new Error("--source must name a supported automated source.");
      result.source = parsed.data;
    } else if (arg === "--profile") result.profile = argv[++index];
    else if (arg === "--max-pages") result.maxPages = Math.max(0, Number(argv[++index] ?? 1));
    else if (arg === "--since") {
      const value = argv[++index];
      const parsed = value ? Date.parse(value) : Number.NaN;
      if (!Number.isFinite(parsed)) throw new Error("--since must be a valid ISO date or timestamp.");
      result.since = new Date(parsed).toISOString();
    } else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--verbose") result.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("sync [--source KEY] [--profile KEY] [--since ISO] [--max-pages N] [--dry-run] [--json] [--verbose]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(result.maxPages) || result.maxPages < 0 || result.maxPages > MAX_PAGES_PER_SOURCE) {
    throw new Error(`--max-pages must be an integer from 0 to ${MAX_PAGES_PER_SOURCE}.`);
  }
  return result;
}

function overallStatus(statuses: RunStatus[]): RunStatus {
  if (statuses.length && statuses.every((status) => status === "success")) return "success";
  if (statuses.some((status) => status === "success" || status === "partial")) return "partial";
  if (statuses.length && statuses.every((status) => status === "blocked")) return "blocked";
  return "failed";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const admin = createSupabaseAdminClient();
  const controller = new AbortController();
  let shutdownSignal: NodeJS.Signals | "RUN_TIMEOUT" | null = null;
  const requestShutdown = (signal: NodeJS.Signals) => {
    shutdownSignal = signal;
    controller.abort();
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  const { data: workspaces, error: workspaceError } = await admin
    .from("workspaces")
    .select("id")
    .eq("id", "00000000-0000-4000-8000-000000000001")
    .limit(1);
  if (workspaceError || !workspaces?.length) throw new Error("No local workspace is configured.");

  const adapterMap = new Map<SourceKey, SourceAdapter>([
    ["otodom", new OtodomSourceAdapter()],
    ["olx", new OlxSourceAdapter()],
    ["domy", createDomyAdapter()],
    ["morizon", new MorizonSourceAdapter()],
    ["gratka", gratkaAdapter],
    ["nieruchomosci_online", nieruchomosciOnlineAdapter],
    ["lento", lentoAdapter],
    ["gethome", getHomeAdapter],
    ["sprzedajemy", sprzedajemyAdapter],
    ["tabelaofert", tabelaOfertAdapter],
    ["homeportal", homePortalAdapter],
    ["domiporta", domiportaAdapter],
    ["adresowo", adresowoAdapter],
  ]);
  const totals: Totals = { new: 0, updated: 0, unchanged: 0, errors: 0 };
  const runId = randomUUID();
  const runStarted = new Date().toISOString();
  const runStartedMs = Date.now();
  const logRows: Array<Record<string, unknown>> = [];
  let requestsUsed = 0;
  const work: Array<{
    workspaceId: string;
    profile: ReturnType<typeof SearchProfileSchema.parse>;
    sourceKey: SourceKey;
    source: { access_status: string; access_note: string | null; enabled: boolean; collection_mode: string };
    adapter?: SourceAdapter;
  }> = [];

  for (const workspace of workspaces) {
    const [{ data: sourceRows, error: sourcesError }, { data: profiles, error: profilesError }] = await Promise.all([
      admin.from("sources").select("source_key,enabled,access_status,access_note,collection_mode").eq("workspace_id", workspace.id),
      admin.from("search_profiles").select("id,profile_key,label,city,preferred_districts,price_max_pln,area_min_m2,area_max_m2,preferred_rooms,transaction,category,mode,sources,enabled,filters").eq("workspace_id", workspace.id).eq("enabled", true),
    ]);
    if (sourcesError || profilesError) throw new Error("Could not load local source and profile configuration.");
    const sourceMap = new Map((sourceRows ?? []).map((source) => [source.source_key, source]));
    const sourceKeys: string[] = args.source
      ? [args.source]
      : [...new Set((profiles ?? []).flatMap((profile) => profile.sources ?? []))];
    for (const profileRow of profiles ?? []) {
      if (args.profile && profileRow.profile_key !== args.profile && profileRow.id !== args.profile) continue;
      const profile = SearchProfileSchema.parse({
        id: profileRow.id,
        key: profileRow.profile_key,
        label: profileRow.label,
        city: profileRow.city,
        preferredDistricts: profileRow.preferred_districts,
        priceMaxPln: profileRow.price_max_pln == null ? undefined : Number(profileRow.price_max_pln),
        areaMinM2: profileRow.area_min_m2 == null ? undefined : Number(profileRow.area_min_m2),
        areaMaxM2: profileRow.area_max_m2 == null ? undefined : Number(profileRow.area_max_m2),
        preferredRooms: profileRow.preferred_rooms,
        otodomSearchUrl: otodomSearchUrlFromFilters(profileRow.filters),
        olxSearchUrl: olxSearchUrlFromFilters(profileRow.filters),
        olxSearchParams: olxSearchParamsFromFilters(profileRow.filters),
        adresowoSearchUrl: adresowoSearchUrlFromFilters(profileRow.filters),
        transaction: profileRow.transaction,
        category: profileRow.category,
        mode: profileRow.mode,
      });
      for (const rawSourceKey of sourceKeys) {
        if (!profileRow.sources?.includes(rawSourceKey)) continue;
        const sourceKey = SourceKeySchema.parse(rawSourceKey);
        if (sourceKey === "manual") continue;
        const source = sourceMap.get(sourceKey);
        if (!source) continue;
        work.push({ workspaceId: workspace.id, profile, sourceKey, source, adapter: adapterMap.get(sourceKey) });
      }
    }
  }

  if (args.profile && work.length === 0) throw new Error("No enabled profile matched the requested value.");
  if (!args.dryRun) {
    const { error } = await admin.from("sync_runs").insert({
      id: runId,
      workspace_id: workspaces[0].id,
      trigger: "local",
      status: "running",
      started_at: runStarted,
    });
    if (error) throw new Error("Could not start a local sync run.");
  }

  let reachedLiveFeed = false;
  const runTimeout = setTimeout(() => {
    shutdownSignal = "RUN_TIMEOUT";
    controller.abort();
  }, MAX_RUN_DURATION_MS);
  try {
    for (const item of work) {
      const sourceStarted = new Date().toISOString();
      const sourceStartedMs = Date.now();
      const lockKey = `${item.sourceKey}:${item.profile.id}`;
      let result: Awaited<ReturnType<typeof discoverSafely>>["batch"] | null = null;
      let runStatus: RunStatus = "failed";
      let errorMessage: string | null = null;
      let errorKind: ScrapeErrorKind | null = null;
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      let writeErrors = 0;
      let lockAcquired = false;
      let skippedCounts: Record<string, number> = {};
      let requestCount = 0;

      try {
        if (controller.signal.aborted) {
          runStatus = "failed";
          errorKind = "TIMEOUT";
          errorMessage = `Worker shutdown (${shutdownSignal ?? "signal"}) before source start.`;
        } else if (item.source.access_status === "BLOCKED_BY_ACCESS_OR_POLICY" || !item.source.enabled || !item.adapter) {
          runStatus = "blocked";
          errorKind = item.source.access_status === "BLOCKED_BY_ACCESS_OR_POLICY" ? "POLICY_BLOCKED" : "UNSUPPORTED";
          errorMessage = item.source.access_status === "BLOCKED_BY_ACCESS_OR_POLICY"
            ? item.source.access_note || "Źródło jest wyłączone z powodu ograniczeń dostępu lub polityki."
            : !item.source.enabled
              ? "Źródło jest wyłączone w lokalnej konfiguracji."
              : "Brak aktywnego adaptera dla tego źródła.";
        } else {
          const { data: acquired, error: lockError } = await admin.rpc("try_acquire_worker_lock", {
            p_workspace_id: item.workspaceId,
            p_lock_key: lockKey,
            p_lease_owner: runId,
            p_lease_seconds: 1800,
          });
          if (lockError) {
            runStatus = "failed";
            errorKind = "INTERNAL";
            errorMessage = "Worker could not acquire the source/profile lease.";
          } else if (acquired !== true) {
            runStatus = "blocked";
            errorKind = "LOCKED";
            errorMessage = "Another worker holds the source/profile lease.";
          } else {
            lockAcquired = true;
            const remainingRequestBudget = Math.max(0, MAX_REQUESTS_PER_RUN - requestsUsed);
            const pageBudget = args.maxPages === 0
              ? 0
              : Math.min(args.maxPages, Math.floor(remainingRequestBudget / MAX_REQUESTS_PER_PAGE));
            if (args.maxPages > 0 && pageBudget < 1) {
              runStatus = "blocked";
              errorKind = "BUDGET_EXHAUSTED";
              errorMessage = `Globalny limit ${MAX_REQUESTS_PER_RUN} żądań na przebieg został wyczerpany.`;
            } else {
              const discovery = await discoverSafely(item.adapter, item.profile, {
                dryRun: args.dryRun,
                maxPages: pageBudget,
                since: args.since,
                verbose: args.verbose,
                signal: controller.signal,
              });
              result = discovery.batch;
              requestCount = result.requestCount ?? result.inspectedPages;
              requestsUsed = Math.min(MAX_REQUESTS_PER_RUN, requestsUsed + requestCount);
              runStatus = discovery.status;
              errorKind = discovery.errorKind;
              errorMessage = discovery.errorMessage;
              skippedCounts = result.skippedCounts ?? {};
              if (result.sourceIsReachable) reachedLiveFeed = true;

              if (requestCount > remainingRequestBudget) {
                runStatus = "partial";
                errorKind = "BUDGET_EXHAUSTED";
                errorMessage = "Adapter przekroczył przydzielony budżet żądań; dalsze źródła pozostają w kolejce.";
              }

              if (!args.dryRun) {
                for (const listing of result.listings) {
                  if (controller.signal.aborted) {
                    runStatus = "partial";
                    errorKind = "TIMEOUT";
                    errorMessage = `Worker shutdown (${shutdownSignal ?? "signal"}) while saving discovered listings.`;
                    totals.errors += 1;
                    writeErrors += 1;
                    break;
                  }
                  const { data, error } = await admin.rpc("ingest_listing_from_worker", {
                    p_workspace_id: item.workspaceId,
                    p_profile_id: item.profile.id,
                    p_listing: listing,
                  });
                  if (error) {
                    totals.errors += 1;
                    writeErrors += 1;
                    runStatus = "partial";
                    errorKind = "INTERNAL";
                    errorMessage = `DB_UPSERT_FAILED (SQLSTATE ${error.code || "unknown"}).`;
                    continue;
                  }
                  const outcome = Array.isArray(data) ? data[0]?.outcome : data?.outcome;
                  if (outcome === "inserted") { inserted += 1; totals.new += 1; }
                  else if (outcome === "updated") { updated += 1; totals.updated += 1; }
                  else { unchanged += 1; totals.unchanged += 1; }
                }
              }
            }
          }
        }
      } catch (error: unknown) {
        runStatus = result?.listings.length ? "partial" : "failed";
        errorKind = controller.signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
          ? "TIMEOUT"
          : error instanceof TypeError ? "NETWORK" : "INTERNAL";
        errorMessage = errorKind === "TIMEOUT"
          ? "Source request was cancelled or timed out."
          : errorKind === "NETWORK"
            ? "Local database or source network request failed."
            : "Source/profile processing failed; other source/profile runs will continue.";
      } finally {
        if (lockAcquired) {
          const { data: released, error: releaseError } = await admin.rpc("release_worker_lock", {
            p_workspace_id: item.workspaceId,
            p_lock_key: lockKey,
            p_lease_owner: runId,
          });
          if (releaseError || released !== true) {
            if (runStatus === "success") runStatus = "partial";
            errorKind ??= "INTERNAL";
            errorMessage = [errorMessage, "Worker lease release failed; it will expire automatically."].filter(Boolean).join(" ").slice(0, 1000);
            totals.errors += 1;
          }
        }

        const finishedAt = new Date().toISOString();
        const durationMs = Math.max(0, Date.now() - sourceStartedMs);
        if (!args.dryRun && result) {
          if (result.errors.some((error) => ["ACCESS_DENIED", "CAPTCHA", "RATE_LIMITED", "POLICY_BLOCKED"].includes(error.kind))) {
            const blockError = result.errors.find((error) => ["ACCESS_DENIED", "CAPTCHA", "RATE_LIMITED", "POLICY_BLOCKED"].includes(error.kind));
            const { error } = await admin.from("sources").update({
              access_status: "BLOCKED_BY_ACCESS_OR_POLICY",
              access_note: blockError?.message ?? "Źródło zablokowało pobieranie.",
              access_checked_at: finishedAt,
            }).eq("workspace_id", item.workspaceId).eq("source_key", item.sourceKey);
            if (error) { totals.errors += 1; runStatus = "partial"; }
          } else if (result.errors.length) {
            const { error } = await admin.from("sources").update({
              access_status: "FAILED",
              access_note: errorMessage,
              access_checked_at: finishedAt,
            }).eq("workspace_id", item.workspaceId).eq("source_key", item.sourceKey).neq("access_status", "LIVE_PASS");
            if (error) { totals.errors += 1; runStatus = "partial"; }
          } else if (result.sourceIsReachable && result.listings.length && inserted + updated + unchanged > 0) {
            const { error } = await admin.from("sources").update({
              access_status: "LIVE_PARTIAL",
              access_note: `Źródło osiągalne; zapisano ${result.listings.length} wpisów z profilu ${item.profile.city}. Pełne potwierdzenie widoku UI pozostaje wymagane przed LIVE_PASS.`,
              access_checked_at: finishedAt,
            }).eq("workspace_id", item.workspaceId).eq("source_key", item.sourceKey).neq("access_status", "LIVE_PASS");
            if (error) { totals.errors += 1; runStatus = "partial"; }
          }
        }

        const errorsForSource = (result?.errors.length ?? 0) + writeErrors + (!result && ["failed", "blocked"].includes(runStatus) ? 1 : 0);
        totals.errors += result ? result.errors.length : 0;
        if (!args.dryRun) {
          const { error } = await admin.from("sync_source_runs").insert({
            workspace_id: item.workspaceId,
            sync_run_id: runId,
            source_key: item.sourceKey,
            profile_id: item.profile.id,
            status: runStatus,
            pages_examined: result?.inspectedPages ?? 0,
            request_count: requestCount,
            found_count: result?.listings.length ?? 0,
            inserted_count: inserted,
            updated_count: updated,
            unchanged_count: unchanged,
            skipped_counts: skippedCounts,
            duration_ms: durationMs,
            error_kind: errorKind,
            error_message: errorMessage,
            started_at: sourceStarted,
            finished_at: finishedAt,
          });
          if (error) {
            totals.errors += 1;
            console.error(`Unable to persist source run (${item.sourceKey}, ${item.profile.key}).`);
          }
        }
        totals.errors += errorsForSource - (result?.errors.length ?? 0) - writeErrors;
        logRows.push({
          source: item.sourceKey,
          profile: item.profile.key,
          status: runStatus,
          duration_ms: durationMs,
          counts: { found: result?.listings.length ?? 0, inserted, updated, unchanged, errors: errorsForSource },
          request_count: requestCount,
          skipped: skippedCounts,
          pages: result?.inspectedPages ?? 0,
          error_kind: errorKind,
          error_message: errorMessage,
        });
      }
    }
  } finally {
    clearTimeout(runTimeout);
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    const finishedAt = new Date().toISOString();
    const status = overallStatus(logRows.map((row) => row.status as RunStatus));
    if (!args.dryRun) {
      const { error } = await admin.from("sync_runs").update({
        status,
        finished_at: finishedAt,
        duration_ms: Math.max(0, Date.now() - runStartedMs),
        total_new: totals.new,
        total_updated: totals.updated,
        total_unchanged: totals.unchanged,
        total_errors: totals.errors,
        error_summary: totals.errors ? `${totals.errors} źródeł lub operacji wymaga uwagi.` : null,
      }).eq("workspace_id", workspaces[0].id).eq("id", runId);
      if (error) throw new Error("Could not finish the local sync run.");
    }

    const report = {
      run_id: runId,
      started_at: runStarted,
      finished_at: finishedAt,
      duration_ms: Math.max(0, Date.now() - runStartedMs),
      status,
      dry_run: args.dryRun,
      since: args.since ?? null,
      verbose: args.verbose,
      live_reachable: reachedLiveFeed,
      shutdown_signal: shutdownSignal,
      request_budget: { limit: MAX_REQUESTS_PER_RUN, used: requestsUsed },
      totals,
      sources: logRows,
    };
    if (args.json) {
      let artifactPath: string | null = null;
      if (!args.dryRun) {
        const reportDir = path.resolve(process.cwd(), "artifacts", "sync-runs");
        await mkdir(reportDir, { recursive: true });
        const reportFile = path.join(reportDir, `${runId}.json`);
        await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        artifactPath = path.relative(process.cwd(), reportFile);
      }
      console.log(JSON.stringify({ ...report, artifact_path: artifactPath }));
    } else {
      console.log(`run_id=${runId} status=${status} dry_run=${args.dryRun} duration_ms=${report.duration_ms}`);
      console.log(`counts=${JSON.stringify(totals)} source_profiles=${logRows.length}`);
      if (args.verbose) for (const row of logRows) console.log(JSON.stringify(row));
    }
    if (["failed", "blocked"].includes(status)) process.exitCode = 1;
    if (shutdownSignal === "RUN_TIMEOUT") process.exitCode = 1;
    else if (shutdownSignal && process.exitCode === undefined) process.exitCode = shutdownSignal === "SIGINT" ? 130 : 143;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local sync failed.");
  process.exitCode = 1;
});
