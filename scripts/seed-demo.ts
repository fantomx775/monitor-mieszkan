import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

async function main() {
const envPath = path.resolve(process.cwd(), ".env.local");
const readEnv = async () => {
  const content = await readFile(envPath, "utf8");
  return Object.fromEntries(
    content.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      return match ? [[match[1], match[2]]] : [];
    }),
  ) as Record<string, string>;
};

const env = await readEnv();
const supabaseUrl = env.SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error("Run pnpm dev:up to prepare local Supabase first.");

const email = env.LOCAL_DEMO_EMAIL || "owner@local.test";
const password = env.LOCAL_DEMO_PASSWORD || randomBytes(30).toString("base64url");
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: users, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listError) throw new Error("Could not inspect local demo account state.");
const existing = users.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
let userId = existing?.id;

if (existing) {
  const { error } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
  if (error) throw new Error("Could not refresh the local demo account.");
} else {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: "Właściciel" },
  });
  if (error || !data.user) throw new Error("Could not create the local demo account.");
  userId = data.user.id;
}

const workspaceId = "00000000-0000-4000-8000-000000000001";
if (!userId) throw new Error("Local demo account has no user id.");
const { error: membershipError } = await admin.from("workspace_members").upsert(
  { workspace_id: workspaceId, user_id: userId, role: "owner" },
  { onConflict: "workspace_id,user_id" },
);
if (membershipError) throw new Error("Could not attach the local account to its workspace.");

if (!env.LOCAL_DEMO_PASSWORD) {
  const updated = env.LOCAL_DEMO_EMAIL
    ? `${(await readFile(envPath, "utf8")).replace(/\r?\n$/, "")}\nLOCAL_DEMO_PASSWORD=${password}\n`
    : `${(await readFile(envPath, "utf8")).replace(/\r?\n$/, "")}\nLOCAL_DEMO_EMAIL=${email}\nLOCAL_DEMO_PASSWORD=${password}\n`;
  await writeFile(envPath, updated, { encoding: "utf8" });
}

console.log("Local demo account is ready. Credentials are stored only in ignored .env.local.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local demo account setup failed.");
  process.exitCode = 1;
});
