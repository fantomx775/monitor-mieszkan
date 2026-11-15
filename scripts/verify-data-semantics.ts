import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

type TestListing = {
  source: "domy" | "morizon";
  externalId: string;
  canonicalUrl: string;
  title: string;
  transaction: "sale";
  category: "apartment";
  market: "unknown";
  pricePln: number | null;
  areaM2: number;
  rooms: number;
  floor: null;
  city: string;
  district: string;
  street: null;
  latitude: null;
  longitude: null;
  publishedAt: string;
  promotedAt: string;
  imageOriginalUrl: null;
  imageAlt: null;
  propertyFeatures: string[];
  sourceEvidence: "rss" | "html";
  capturedAt: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const envText = await readFile(path.resolve(process.cwd(), ".env.local"), "utf8");
  const env = Object.fromEntries(envText.split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf("=");
    return index < 0 ? [] : [[line.slice(0, index), line.slice(index + 1)]];
  })) as Record<string, string>;
  const localUrl = new URL(env.SUPABASE_URL ?? "");
  if (!["127.0.0.1", "localhost"].includes(localUrl.hostname)) {
    throw new Error("Data semantics verification only runs against local Supabase.");
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Local Supabase is not configured.");

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const testId = randomUUID();
  const workspaceId = randomUUID();
  const profileId = randomUUID();
  let workspaceCreated = false;

  async function cleanup() {
    if (!workspaceCreated) return;
    const tables = [
      "listing_notes", "listing_price_events", "listing_field_events",
      "listing_duplicate_candidates", "listing_user_state", "listing_profile_matches",
      "source_listings", "sync_source_runs", "sync_runs", "search_profiles", "sources", "workspace_members",
    ];
    const deletes = tables.map((table) => `delete from public.${table} where workspace_id = '${workspaceId}';`).join(" ");
    const sql = `do $$ begin ${deletes} delete from public.workspaces where id = '${workspaceId}' and name = 'Data semantics verification ${testId}'; end $$;`;
    try {
      execFileSync(process.execPath, [
        path.resolve(process.cwd(), "node_modules/supabase/dist/supabase.js"),
        "db", "query", sql,
      ], { cwd: process.cwd(), stdio: "ignore" });
    } catch {
      throw new Error("Could not clean the isolated verification workspace through the local Supabase CLI.");
    }
  }

  try {
    const setupSql = `do $$ begin
      insert into public.workspaces (id, name, timezone)
        values ('${workspaceId}', 'Data semantics verification ${testId}', 'Europe/Warsaw');
      insert into public.sources (workspace_id, source_key, name, base_url, enabled, collection_mode, access_status)
        values
          ('${workspaceId}', 'domy', 'Domy test', 'https://domy.pl', true, 'rss', 'NOT_TESTED'),
          ('${workspaceId}', 'morizon', 'Morizon test', 'https://www.morizon.pl', true, 'html', 'NOT_TESTED');
      insert into public.search_profiles (id, workspace_id, profile_key, label, city, mode, sources, filters)
        values ('${profileId}', '${workspaceId}', 'data-semantics-${testId}', 'Data semantics fixture', 'Katowice', 'discovery', array['domy','morizon']::text[], jsonb_build_object('testRun','${testId}'));
    end $$;`;
    try {
      execFileSync(process.execPath, [
        path.resolve(process.cwd(), "node_modules/supabase/dist/supabase.js"),
        "db", "query", setupSql,
      ], { cwd: process.cwd(), stdio: "ignore" });
      workspaceCreated = true;
    } catch {
      workspaceCreated = true;
      throw new Error("Could not prepare an isolated verification workspace through the local Supabase CLI.");
    }

    const capturedAt = new Date().toISOString();
    const publishedAt = "2025-01-01T00:00:00.000Z";
    const promotedAt = "2025-02-01T00:00:00.000Z";
    const listing = (
      source: TestListing["source"],
      externalId: string,
      pricePln: number | null,
      areaM2: number,
      rooms: number,
    ): TestListing => ({
      source,
      externalId,
      canonicalUrl: `https://${source === "domy" ? "domy.pl" : "www.morizon.pl"}/acceptance/${testId}/${externalId}`,
      title: "Synthetic acceptance listing",
      transaction: "sale",
      category: "apartment",
      market: "unknown",
      pricePln,
      areaM2,
      rooms,
      floor: null,
      city: "Katowice",
      district: "Test",
      street: null,
      latitude: null,
      longitude: null,
      publishedAt,
      promotedAt,
      imageOriginalUrl: null,
      imageAlt: null,
      propertyFeatures: [],
      sourceEvidence: source === "domy" ? "rss" : "html",
      capturedAt,
    });
    const ingest = async (value: TestListing) => {
      const { data, error } = await admin.rpc("ingest_listing_from_worker", {
        p_workspace_id: workspaceId,
        p_profile_id: profileId,
        p_listing: value,
      });
      if (error || !data?.[0]) throw new Error(`Synthetic import failed (SQLSTATE ${error?.code || "unknown"}).`);
      return data[0] as { listing_id: string; outcome: string; price_changed: boolean };
    };

    const initial = Array.from({ length: 10 }, (_, index) => {
      const number = index + 1;
      return listing("domy", `test-${testId}-${number}`, 300000 + number * 50000, 40 + number * 5, 1 + (number % 4));
    });
    const firstOutcomes = await Promise.all(initial.map(ingest));
    assert(firstOutcomes.every((row) => row.outcome === "inserted"), "First fixture import must insert all ten rows.");
    const repeatedOutcomes = await Promise.all(initial.map(ingest));
    assert(repeatedOutcomes.every((row) => row.outcome === "unchanged"), "Repeated fixture import must be idempotent.");

    const target = initial[3];
    const targetId = firstOutcomes[3].listing_id;
    const { data: initialRow, error: initialRowError } = await admin
      .from("source_listings")
      .select("first_seen_at")
      .eq("workspace_id", workspaceId)
      .eq("id", targetId)
      .single();
    if (initialRowError || !initialRow) throw new Error("Could not read the synthetic listing baseline.");

    const samePortalA = listing("domy", `same-portal-a-${testId}`, 425000, 43, 2);
    const samePortalB = listing("domy", `same-portal-b-${testId}`, 425000, 43, 2);
    const [sameA, sameB] = await Promise.all([ingest(samePortalA), ingest(samePortalB)]);
    assert(sameA.listing_id !== sameB.listing_id, "Different source IDs with matching attributes must remain separate rows.");

    const crossSource = await ingest(listing("morizon", `cross-source-${testId}`, target.pricePln, target.areaM2, target.rooms));
    assert(crossSource.listing_id !== targetId, "Cross-source offers must never be auto-merged.");
    const { data: candidateRows, error: candidateError } = await admin
      .from("listing_duplicate_candidates")
      .select("source_listing_id,candidate_listing_id,confidence,reasons_json")
      .eq("workspace_id", workspaceId);
    if (candidateError) throw new Error(`Could not inspect cross-source candidate (SQLSTATE ${candidateError.code || "unknown"}).`);
    assert(candidateRows?.length === 1, "One cross-source match should create exactly one duplicate candidate.");
    assert(candidateRows[0].confidence === 0.9 && Array.isArray(candidateRows[0].reasons_json), "Candidate confidence and match reasons must be recorded.");

    const reducedPrice = { ...target, pricePln: 385000 };
    const reduction = await ingest(reducedPrice);
    assert(reduction.outcome === "updated" && reduction.price_changed, "A price reduction should update the existing row.");
    const repeatedReduction = await ingest(reducedPrice);
    assert(repeatedReduction.outcome === "unchanged" && !repeatedReduction.price_changed, "An unchanged price should not create a second change.");
    const nullPrice = await ingest({ ...reducedPrice, pricePln: null });
    assert(nullPrice.outcome === "unchanged" && !nullPrice.price_changed, "A null price should not be treated as a price change.");

    const { data: priceEvents, error: priceError } = await admin
      .from("listing_price_events")
      .select("old_price_pln,new_price_pln")
      .eq("workspace_id", workspaceId)
      .eq("listing_id", targetId);
    if (priceError) throw new Error(`Could not inspect price history (SQLSTATE ${priceError.code || "unknown"}).`);
    assert(priceEvents?.length === 1 && priceEvents[0].old_price_pln === target.pricePln && priceEvents[0].new_price_pln === 385000, "A single price reduction should create exactly one price event.");

    const updatedDates = await ingest({
      ...reducedPrice,
      publishedAt: "2026-01-01T00:00:00.000Z",
      promotedAt: "2026-02-01T00:00:00.000Z",
    });
    assert(updatedDates.outcome === "unchanged", "Publication or promotion dates alone must not mark an offer as newly changed.");
    const { data: finalRow, error: finalRowError } = await admin
      .from("source_listings")
      .select("first_seen_at,price_pln,published_at,promoted_at,life_cycle")
      .eq("workspace_id", workspaceId)
      .eq("id", targetId)
      .single();
    if (finalRowError || !finalRow) throw new Error("Could not inspect the final synthetic listing state.");
    assert(finalRow.first_seen_at === initialRow.first_seen_at, "first_seen_at must remain stable across reimports.");
    assert(finalRow.price_pln === 385000, "A null price must not overwrite a known price.");
    assert(finalRow.published_at === "2026-01-01T00:00:00+00:00" && finalRow.promoted_at === "2026-02-01T00:00:00+00:00", "Publication and promotion dates should update independently of first_seen_at.");

    const { error: profileUpdateError } = await admin
      .from("search_profiles")
      .update({ area_min_m2: 80, price_max_pln: 350000 })
      .eq("workspace_id", workspaceId)
      .eq("id", profileId);
    if (profileUpdateError) throw new Error(`Could not change synthetic search criteria (SQLSTATE ${profileUpdateError.code || "unknown"}).`);
    const { count: listingCount, error: countError } = await admin
      .from("source_listings")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (countError) throw new Error("Could not verify listing retention after profile changes.");
    assert(listingCount === 13, "Changing search criteria must not delete imported listings.");

    console.log("DATA SEMANTICS PASS: 10 inserts are idempotent; distinct IDs stay separate; price history, null values, first-seen dates, profile changes, and cross-source candidates are preserved.");
  } finally {
    await cleanup();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Data semantics verification failed.");
  process.exitCode = 1;
});
