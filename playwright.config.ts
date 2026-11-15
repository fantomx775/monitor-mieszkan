import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const envPath = path.resolve(process.cwd(), ".env.local");
let localEnv: Record<string, string> = {};
try {
  localEnv = Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(LOCAL_DEMO_EMAIL|LOCAL_DEMO_PASSWORD)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
} catch {
  // The test will clearly fail with the documented local account prerequisite.
}
for (const [key, value] of Object.entries(localEnv)) process.env[key] = value;

mkdirSync(path.resolve(process.cwd(), "artifacts", "screenshots"), { recursive: true });

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
