import { describe, expect, it, vi } from "vitest";

import { domiportaAdapter } from "./domiporta/adapter";
import { gratkaAdapter } from "./gratka/adapter";
import type { SearchProfile, SourceAdapter } from "./contracts";

const profile: SearchProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  key: "katowice-400",
  label: "Katowice",
  city: "Katowice",
  preferredDistricts: [],
  preferredRooms: [],
  transaction: "sale",
  category: "apartment",
  mode: "discovery",
};

describe.each([
  ["gratka", gratkaAdapter],
  ["domiporta", domiportaAdapter],
] satisfies Array<[string, SourceAdapter]>)("policy-blocked adapter %s", (source, adapter) => {
  it("returns a diagnostic and performs no network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const batch = await adapter.discover(profile, { dryRun: false, maxPages: 20 });
      const health = await adapter.healthcheck();

      expect(batch.source).toBe(source);
      expect(batch.listings).toEqual([]);
      expect(batch.inspectedPages).toBe(0);
      expect(batch.sourceIsReachable).toBe(false);
      expect(batch.errors[0]?.kind).toBe("POLICY_BLOCKED");
      expect(batch.errors[0]?.message).toBeTruthy();
      expect(health.status).toBe("BLOCKED_BY_ACCESS_OR_POLICY");
      expect(health.diagnostic).toBe(batch.errors[0]?.message);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
