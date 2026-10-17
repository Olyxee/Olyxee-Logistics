import { describe, expect, it } from "vitest";
import { featureFlags, getPlan, isValidPlanId, plans } from "./index";

describe("plan catalog", () => {
  it("keeps every selectable plan resolvable", () => {
    for (const id of ["beta", "free", "pro", "business"] as const) {
      expect(isValidPlanId(id)).toBe(true);
      expect(getPlan(id)).toBe(plans[id]);
    }
  });

  it("enables SMS lifecycle notifications without plan quotas", () => {
    expect(featureFlags.smsNotifications).toBe(true);
    for (const id of ["beta", "free", "pro", "business"] as const) {
      expect(getPlan(id).smsLimit).toBeNull();
    }
  });

  it("keeps unfinished launch features disabled", () => {
    expect(featureFlags.subscriptionBilling).toBe(false);
    expect(featureFlags.planEnforcement).toBe(false);
    expect(featureFlags.publicApi).toBe(false);
    expect(featureFlags.automatedCallCentre).toBe(false);
  });
});
