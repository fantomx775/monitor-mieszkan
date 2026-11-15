import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const screenshots = "artifacts/screenshots";
const demoWorkspaceId = "00000000-0000-4000-8000-000000000001";

type ListingUserSnapshot = {
  favorite: boolean;
  review_status: string;
  reviewed_at: string | null;
  viewing_scheduled_at: string | null;
  updated_by: string | null;
  updated_at: string;
};

function localAdmin() {
  let envText: string;
  try {
    envText = readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
  } catch {
    throw new Error("Local Supabase is not configured for safe E2E cleanup.");
  }
  const env = Object.fromEntries(envText.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=(.*)$/);
    if (!match) return [];
    const value = match[2].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
    return [[match[1], value]];
  })) as Record<string, string>;
  const endpoint = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint ?? "");
  } catch {
    throw new Error("E2E cleanup only runs against local Supabase.");
  }
  if (parsedUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsedUrl.hostname)) {
    throw new Error("E2E cleanup only runs against local Supabase.");
  }
  if (!serviceKey) throw new Error("Local Supabase is not configured for safe E2E cleanup.");
  return createClient(endpoint!, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  const email = process.env.LOCAL_DEMO_EMAIL;
  const password = process.env.LOCAL_DEMO_PASSWORD;
  if (!email || !password) throw new Error("Local demo credentials are missing. Run pnpm demo:seed.");
  await page.getByLabel("Adres e-mail").fill(email);
  await page.getByLabel("Hasło").fill(password);
  await page.getByRole("button", { name: "Zaloguj do panelu" }).click();
  await expect(page.getByRole("heading", { name: "Dzień dobry" })).toBeVisible();
}

test("protects the private panel and captures desktop and mobile views", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await signIn(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${screenshots}/dashboard-desktop.png` });
  await page.goto("/oferty");
  await expect(page.getByRole("heading", { name: "Oferty" })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/oferty-desktop.png` });
  const detailHref = await page.locator(".listing-card a[href^='/oferty/']").first().getAttribute("href").catch(() => null);
  if (detailHref) {
    await page.goto(detailHref);
    await page.screenshot({ path: `${screenshots}/szczegoly-desktop.png` });
  }
  await page.goto("/zrodla");
  await expect(page.getByRole("heading", { name: "Źródła" })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/zrodla-desktop.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, filename] of [["/", "dashboard-mobile.png"], ["/oferty", "oferty-mobile.png"], [detailHref ?? "/oferty", "szczegoly-mobile.png"], ["/zrodla", "zrodla-mobile.png"]] as const) {
    await page.goto(route);
    await page.screenshot({ path: `${screenshots}/${filename}`, fullPage: true });
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `horizontal overflow on ${route}`).toBeLessThanOrEqual(390);
  }
});

test("favorite, note, and decision status survive a repeat live RSS sync", async ({ page }) => {
  await signIn(page);
  await page.goto("/oferty?source=domy");
  expect(await page.locator(".listing-card").count()).toBeGreaterThanOrEqual(2);
  const card = page.locator(".listing-card").first();
  if (!(await card.count())) throw new Error("No live Domy.pl listings are in the local database.");
  const detailHref = await card.locator("a[href^='/oferty/']").first().getAttribute("href");
  if (!detailHref) throw new Error("Live listing has no detail route.");
  const listingId = detailHref.split("?")[0].split("/").at(-1);
  if (!listingId || !/^[0-9a-f-]{36}$/i.test(listingId)) throw new Error("Live listing detail route did not contain a UUID.");
  const admin = localAdmin();
  const { data: state, error: stateError } = await admin
    .from("listing_user_state")
    .select("favorite,review_status,reviewed_at,viewing_scheduled_at,updated_by,updated_at")
    .eq("workspace_id", demoWorkspaceId)
    .eq("listing_id", listingId)
    .single();
  if (stateError || !state) throw new Error("Could not capture the current listing state for safe E2E cleanup.");

  const snapshot = state as ListingUserSnapshot;
  const note = `E2E zachowanie po sync ${randomUUID()}`;
  const expectedStatus = snapshot.review_status === "to_contact" ? "interesting" : "to_contact";
  try {
    if (!snapshot.favorite) await card.getByRole("button", { name: "Dodaj do ulubionych" }).click();
    await page.goto("/ulubione");
    await expect(page.locator(`a[href='${detailHref}']`).first()).toBeVisible();

    await page.goto(detailHref);
    await page.getByLabel("Dodaj notatkę").fill(note);
    await page.getByRole("button", { name: "Zapisz notatkę" }).click();
    await expect(page.getByText(note)).toBeVisible();
    await page.getByLabel("Status").selectOption(expectedStatus);
    await page.getByRole("button", { name: "Zapisz status" }).click();

    try {
      execFileSync("docker", ["compose", "--env-file", ".env.local", "run", "--rm", "worker", "worker:sync", "--source", "domy", "--profile", "katowice-400", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw new Error("Local Domy sync failed during the E2E persistence scenario.");
    }

    await page.reload();
    await expect(page.getByLabel("Status")).toHaveValue(expectedStatus);
    await expect(page.getByText(note)).toBeVisible();
    await page.goto("/ulubione");
    await expect(page.locator(`a[href='${detailHref}']`).first()).toBeVisible();
    await page.goto(detailHref);
    await expect(page.locator(".page-heading .quick-actions button")).toContainText("Ulubiona");
  } finally {
    const cleanupErrors: string[] = [];
    try {
      const cleanupSql = `delete from public.listing_notes where workspace_id = '${demoWorkspaceId}' and listing_id = '${listingId}' and body = '${note}';`;
      execFileSync(process.execPath, [path.resolve(process.cwd(), "node_modules/supabase/dist/supabase.js"), "db", "query", cleanupSql], { cwd: process.cwd(), stdio: "ignore" });
    } catch {
      cleanupErrors.push("temporary note");
    }

    const { error: stateRestoreError } = await admin
      .from("listing_user_state")
      .update({
        favorite: snapshot.favorite,
        review_status: snapshot.review_status,
        reviewed_at: snapshot.reviewed_at,
        viewing_scheduled_at: snapshot.viewing_scheduled_at,
        updated_by: snapshot.updated_by,
        updated_at: snapshot.updated_at,
      })
      .eq("workspace_id", demoWorkspaceId)
      .eq("listing_id", listingId);
    if (stateRestoreError) cleanupErrors.push("listing user state");
    if (cleanupErrors.length) throw new Error(`E2E cleanup failed for ${cleanupErrors.join(" and ")}.`);
  }
});

test("manual URL stores only user-entered fields and renders missing values safely", async ({ page }) => {
  await signIn(page);
  const url = `https://domy.pl/mieszkanie/acceptance-${randomUUID()}`;
  const title = "Synthetic manual-link acceptance";
  await page.goto("/dodaj");
  await page.getByLabel("Link do ogłoszenia").fill(url);
  await page.getByLabel("Tytuł").fill(title);
  await page.getByLabel("Miasto").fill("Katowice");

  try {
    await page.getByRole("button", { name: "Zapisz do listy" }).click();
    await expect(page).toHaveURL(/\/oferty\/[0-9a-f-]{36}$/i);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.locator(".detail-facts")).not.toContainText("NaN");
    await expect(page.locator(".detail-facts")).toContainText("—");
  } finally {
    const cleanupSql = `do $$ declare target_id uuid; begin select id into target_id from public.source_listings where workspace_id = '${demoWorkspaceId}' and source_key = 'manual' and canonical_url = '${url}'; if target_id is not null then delete from public.listing_notes where workspace_id = '${demoWorkspaceId}' and listing_id = target_id; delete from public.listing_price_events where workspace_id = '${demoWorkspaceId}' and listing_id = target_id; delete from public.listing_field_events where workspace_id = '${demoWorkspaceId}' and listing_id = target_id; delete from public.listing_duplicate_candidates where workspace_id = '${demoWorkspaceId}' and (source_listing_id = target_id or candidate_listing_id = target_id); delete from public.listing_user_state where workspace_id = '${demoWorkspaceId}' and listing_id = target_id; delete from public.listing_profile_matches where workspace_id = '${demoWorkspaceId}' and listing_id = target_id; delete from public.source_listings where workspace_id = '${demoWorkspaceId}' and id = target_id and source_key = 'manual'; end if; end $$;`;
    execFileSync(process.execPath, [path.resolve(process.cwd(), "node_modules/supabase/dist/supabase.js"), "db", "query", cleanupSql], { cwd: process.cwd(), stdio: "ignore" });
  }
});
