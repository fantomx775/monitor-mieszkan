import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SearchProfileSchema } from "../contracts";
import { OtodomSourceAdapter } from "./adapter";
import { allowsOtodomAiInput, parseOtodomContentSignal } from "./policy";

const profile = SearchProfileSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  key: "katowice",
  label: "Katowice",
  city: "Katowice",
  preferredDistricts: [],
  preferredRooms: [],
  mode: "discovery",
});

describe("Otodom source adapter", () => {
  it("treats the observed robots content signal as disallowing AI input", () => {
    const robotsFixture = readFileSync(
      fileURLToPath(new URL("./fixtures/robots-content-signal.txt", import.meta.url)),
      "utf8",
    );
    const contentSignal = parseOtodomContentSignal(robotsFixture);

    expect(contentSignal).toEqual({ search: "yes", "ai-input": "no", "ai-train": "no" });
    expect(allowsOtodomAiInput(contentSignal)).toBe(false);
  });

  it("requires a saved results URL before requesting a page", async () => {
    const adapter = new OtodomSourceAdapter();

    const result = await adapter.discover(profile, { dryRun: false, maxPages: 3 });

    expect(result).toMatchObject({
      source: "otodom",
      profileId: profile.id,
      listings: [],
      inspectedPages: 0,
      isFullTraversal: false,
      sourceIsReachable: false,
      errors: [{ kind: "UNSUPPORTED" }],
    });
    await expect(adapter.healthcheck()).resolves.toMatchObject({
      status: "NOT_TESTED",
    });
  });

  it("does not make a request when the page budget is zero", async () => {
    const adapter = new OtodomSourceAdapter();

    const result = await adapter.discover(profile, { dryRun: true, maxPages: 0 });

    expect(result.errors).toEqual([]);
    expect(result.inspectedPages).toBe(0);
    expect(result.requestCount).toBe(0);
  });
});
