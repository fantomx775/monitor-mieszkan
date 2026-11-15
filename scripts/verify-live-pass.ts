import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const text = await readFile(path.resolve(process.cwd(), ".env.local"), "utf8");
  const env = Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  })) as Record<string, string>;
  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Local Supabase is not configured.");

  const evidencePaths = ["artifacts/screenshots/oferty-desktop.png", "artifacts/screenshots/szczegoly-desktop.png"];
  for (const relativePath of evidencePaths) {
    const file = await stat(path.resolve(process.cwd(), relativePath)).catch(() => null);
    if (!file || file.size < 1000) throw new Error("Authenticated Playwright offer and detail screenshots are required.");
  }

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const { data: rows, error } = await admin
    .from("source_listings")
    .select("external_id,canonical_url,city,transaction,category,price_pln,source_evidence")
    .eq("workspace_id", workspaceId)
    .eq("source_key", "domy")
    .eq("city", "Katowice")
    .eq("source_evidence", "rss")
    .limit(1000);
  if (error) throw new Error("Could not inspect local Domy.pl RSS records.");
  const records = rows ?? [];
  const uniqueIds = new Set(records.map((row) => row.external_id));
  const valid = records.filter((row) => {
    try {
      return new URL(row.canonical_url).hostname === "domy.pl" &&
        row.transaction === "sale" && row.category === "apartment";
    } catch {
      return false;
    }
  });
  const priced = valid.filter((row) => row.price_pln != null);
  if (uniqueIds.size < 2 || valid.length < 2 || priced.length < 2) {
    throw new Error("At least two distinct, priced Domy.pl Katowice sale-apartment records are required.");
  }

  const checkedAt = new Date().toISOString();
  const { error: updateError } = await admin.from("sources").update({
    access_status: "LIVE_PASS",
    access_note: `Potwierdzono ${valid.length} odrębnych rekordów RSS w lokalnej DB oraz uwierzytelniony Playwright widok katalogu i szczegółów (${checkedAt}). Feed jest ograniczony do bieżącego kanału; nie oznacza pełnego pokrycia rynku.`,
    access_checked_at: checkedAt,
    last_live_pass_at: checkedAt,
  }).eq("workspace_id", workspaceId).eq("source_key", "domy");
  if (updateError) throw new Error("Could not record local Domy.pl verification status.");
  console.log(JSON.stringify({ source: "domy", status: "LIVE_PASS", city: "Katowice", distinctRecords: uniqueIds.size, validRecords: valid.length, pricedRecords: priced.length, screenshots: evidencePaths }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Live source verification failed.");
  process.exitCode = 1;
});
