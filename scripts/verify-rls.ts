import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  const envText = await readFile(envPath, "utf8");
  const env = Object.fromEntries(envText.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) return [];
    const value = match[2].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
    return [[match[1], value]];
  })) as Record<string, string>;
  const url = env.SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) throw new Error("Local Supabase credentials are not configured.");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("RLS verification only runs against local Supabase.");
  }
  if (parsedUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsedUrl.hostname)) {
    throw new Error("RLS verification only runs against local Supabase.");
  }

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const workspaceA = "00000000-0000-4000-8000-000000000001";
  const workspaceB = randomUUID();
  const workspaceBName = `RLS isolation check ${workspaceB}`;
  const email = `rls-${randomUUID()}@local.test`;
  const password = randomBytes(24).toString("base64url");
  const sharedEmail = `rls-shared-${randomUUID()}@local.test`;
  const sharedPassword = randomBytes(24).toString("base64url");
  const listingId = randomUUID();
  const dailyReportId = randomUUID();
  const objectPath = `${workspaceA}/${randomUUID()}.png`;
  let userId: string | null = null;
  let sharedUserId: string | null = null;
  let workspacePrepared = false;
  let dailyReportPrepared = false;
  let objectUploaded = false;

  try {
    const { error: workspaceError } = await admin.from("workspaces").insert({ id: workspaceB, name: workspaceBName, timezone: "Europe/Warsaw" });
    if (workspaceError) throw new Error("Could not create the isolated test workspace.");
    workspacePrepared = true;
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createError || !created.user) throw new Error("Could not create temporary RLS test account.");
    userId = created.user.id;
    const { error: memberError } = await admin.from("workspace_members").upsert({ workspace_id: workspaceB, user_id: userId, role: "owner" }, { onConflict: "workspace_id,user_id" });
    if (memberError) throw new Error("Could not add temporary account to the isolated workspace.");

    const { data: sharedCreated, error: sharedCreateError } = await admin.auth.admin.createUser({ email: sharedEmail, password: sharedPassword, email_confirm: true });
    if (sharedCreateError || !sharedCreated.user) throw new Error("Could not create the second temporary workspace account.");
    sharedUserId = sharedCreated.user.id;
    const { error: sharedMemberError } = await admin.from("workspace_members").upsert({ workspace_id: workspaceB, user_id: sharedUserId, role: "member" }, { onConflict: "workspace_id,user_id" });
    if (sharedMemberError) throw new Error("Could not add the second temporary account to the isolated workspace.");

    const localCli = path.resolve(process.cwd(), "node_modules/supabase/dist/supabase.js");
    const sourceSql = `insert into public.sources (workspace_id, source_key, name, base_url, enabled, collection_mode, access_status) values ('${workspaceB}', 'manual', 'RLS test manual', 'https://domy.pl', true, 'manual', 'NOT_TESTED');`;
    execFileSync(process.execPath, [localCli, "db", "query", sourceSql], { cwd: process.cwd(), stdio: "ignore" });
    const { error: listingInsertError } = await admin.from("source_listings").insert({
      id: listingId,
      workspace_id: workspaceB,
      source_key: "manual",
      external_id: `rls-${randomUUID()}`,
      canonical_url: `https://domy.pl/rls-${randomUUID()}`,
      title: "Synthetic shared workspace listing",
      city: "Katowice",
      source_evidence: "manual",
    });
    if (listingInsertError) throw new Error("Could not create a temporary shared listing.");
    const { error: stateInsertError } = await admin.from("listing_user_state").upsert({
      workspace_id: workspaceB,
      listing_id: listingId,
      favorite: true,
      review_status: "to_contact",
      updated_by: userId,
    }, { onConflict: "workspace_id,listing_id" });
    if (stateInsertError) throw new Error("Could not create a temporary shared listing state.");
    const { error: noteInsertError } = await admin.from("listing_notes").insert({
      workspace_id: workspaceB,
      listing_id: listingId,
      author_id: userId,
      body: "Synthetic shared workspace note",
    });
    if (noteInsertError) throw new Error("Could not create a temporary shared note.");

    const reportTime = new Date().toISOString();
    const { error: reportInsertError } = await admin.from("daily_reports").insert({
      id: dailyReportId,
      workspace_id: workspaceA,
      period_start: reportTime,
      period_end: reportTime,
      generated_at: reportTime,
      baseline: true,
      payload_json: { verification_fixture: true },
    });
    if (reportInsertError) throw new Error("Could not create a temporary daily-report RLS row.");
    dailyReportPrepared = true;

    const { error: uploadError } = await admin.storage.from("listing-thumbnails").upload(objectPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { contentType: "image/png", upsert: true });
    if (uploadError) throw new Error("Could not create temporary private-storage test object.");
    objectUploaded = true;

    const user = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: signInError } = await user.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error("Temporary user could not sign in.");
    const [
      { data: listings, error: listingError },
      { data: notes, error: noteError },
      { data: reportRows, error: reportError },
      { data: objects, error: storageError },
    ] = await Promise.all([
      user.from("source_listings").select("id").eq("workspace_id", workspaceA).limit(10),
      user.from("listing_notes").select("id").eq("workspace_id", workspaceA).limit(10),
      user.from("daily_reports").select("id").eq("workspace_id", workspaceA).eq("id", dailyReportId),
      user.storage.from("listing-thumbnails").list(workspaceA, { limit: 10 }),
    ]);
    if (listingError || noteError || reportError) throw new Error("RLS checks could not read the target tables.");
    if (listings?.length || notes?.length || reportRows?.length) throw new Error("RLS leak: another workspace exposed offer, note, or daily-report rows.");
    if ((!storageError && objects?.some((object) => object.name === objectPath.split("/")[1])) || (storageError && storageError.message !== "Object not found")) {
      throw new Error("RLS leak: another workspace exposed a private Storage path.");
    }

    const { data: attemptedUpdate, error: updateError } = await user
      .from("listing_user_state")
      .update({ favorite: true })
      .eq("workspace_id", workspaceA)
      .select("listing_id");
    if (updateError && updateError.code !== "42501") throw new Error("Unexpected error during cross-workspace write check.");
    if (attemptedUpdate?.length) throw new Error("RLS leak: another workspace changed listing user state.");

    const sharedUser = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: sharedSignInError } = await sharedUser.auth.signInWithPassword({ email: sharedEmail, password: sharedPassword });
    if (sharedSignInError) throw new Error("The second workspace member could not sign in.");
    const [{ data: sharedListings, error: sharedListingError }, { data: sharedStates, error: sharedStateError }, { data: sharedNotes, error: sharedNoteError }] = await Promise.all([
      sharedUser.from("source_listings").select("id").eq("workspace_id", workspaceB).eq("id", listingId),
      sharedUser.from("listing_user_state").select("listing_id,favorite,review_status").eq("workspace_id", workspaceB).eq("listing_id", listingId),
      sharedUser.from("listing_notes").select("listing_id,body").eq("workspace_id", workspaceB).eq("listing_id", listingId),
    ]);
    if (sharedListingError || sharedStateError || sharedNoteError) throw new Error("The second workspace member could not read shared shortlist state.");
    if (sharedListings?.length !== 1 || sharedStates?.[0]?.favorite !== true || sharedStates[0].review_status !== "to_contact" || sharedNotes?.[0]?.body !== "Synthetic shared workspace note") {
      throw new Error("Members of the same workspace could not see shared listing state and notes.");
    }

    console.log("RLS PASS: workspace B members share shortlist state and notes; workspace B cannot read workspace A offers, notes, reports, or storage, or change its state.");
  } finally {
    const cleanupErrors: string[] = [];
    const attemptCleanup = async (label: string, action: () => Promise<void> | void) => {
      try {
        await action();
      } catch {
        cleanupErrors.push(label);
      }
    };

    if (objectUploaded) {
      await attemptCleanup("private Storage object", async () => {
        const { error } = await admin.storage.from("listing-thumbnails").remove([objectPath]);
        if (error) throw error;
      });
    }
    if (dailyReportPrepared) {
      await attemptCleanup("temporary daily report", () => {
        execFileSync(process.execPath, [
          path.resolve(process.cwd(), "node_modules/supabase/dist/supabase.js"),
          "db", "query",
          `delete from public.daily_reports where workspace_id = '${workspaceA}' and id = '${dailyReportId}';`,
        ], { cwd: process.cwd(), stdio: "ignore" });
      });
    }
    if (workspacePrepared) {
      await attemptCleanup("temporary workspace records", () => {
        const cleanupSql = `do $$ begin delete from public.listing_notes where workspace_id = '${workspaceB}'; delete from public.listing_price_events where workspace_id = '${workspaceB}'; delete from public.listing_field_events where workspace_id = '${workspaceB}'; delete from public.listing_duplicate_candidates where workspace_id = '${workspaceB}'; delete from public.listing_user_state where workspace_id = '${workspaceB}'; delete from public.listing_profile_matches where workspace_id = '${workspaceB}'; delete from public.source_listings where workspace_id = '${workspaceB}'; delete from public.search_profiles where workspace_id = '${workspaceB}'; delete from public.sources where workspace_id = '${workspaceB}'; delete from public.workspace_members where workspace_id = '${workspaceB}'; end $$;`;
        execFileSync(process.execPath, [path.resolve(process.cwd(), "node_modules/supabase/dist/supabase.js"), "db", "query", cleanupSql], { cwd: process.cwd(), stdio: "ignore" });
      });
    }
    if (userId) {
      await attemptCleanup("temporary owner account", async () => {
        const { error } = await admin.auth.admin.deleteUser(userId!);
        if (error) throw error;
      });
    }
    if (sharedUserId) {
      await attemptCleanup("temporary member account", async () => {
        const { error } = await admin.auth.admin.deleteUser(sharedUserId!);
        if (error) throw error;
      });
    }
    if (workspacePrepared) {
      await attemptCleanup("temporary workspace", () => {
        execFileSync(process.execPath, [
          path.resolve(process.cwd(), "node_modules/supabase/dist/supabase.js"),
          "db", "query",
          `delete from public.workspaces where id = '${workspaceB}' and name = '${workspaceBName}';`,
        ], { cwd: process.cwd(), stdio: "ignore" });
      });
    }
    if (cleanupErrors.length) throw new Error(`RLS checks could not clean up: ${cleanupErrors.join(", ")}.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "RLS verification failed.");
  process.exitCode = 1;
});
