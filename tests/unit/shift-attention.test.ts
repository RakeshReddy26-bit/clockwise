import { describe, it, expect } from "vitest";
import { shiftAttention, countUnderstaffed } from "@/lib/shift-attention";

describe("shiftAttention", () => {
  it("reports understaffed when seats remain", () => {
    const a = shiftAttention({ filled: 1, requiredCount: 3, hasOpenOffer: false });
    expect(a.level).toBe("understaffed");
    expect(a.openSeats).toBe(2);
  });

  it("reports staffed when every seat is taken", () => {
    const a = shiftAttention({ filled: 3, requiredCount: 3, hasOpenOffer: false });
    expect(a.level).toBe("staffed");
    expect(a.openSeats).toBe(0);
  });

  /**
   * The regression this module exists for. The table used to test the offer
   * first, so a shift with an offer out rendered "Offer sent" and nothing
   * else — hiding the empty seats a manager was scanning the column to find.
   */
  it("an open offer NEVER hides that seats are still unfilled", () => {
    const a = shiftAttention({ filled: 1, requiredCount: 3, hasOpenOffer: true });
    expect(a.level).toBe("understaffed");
    expect(a.openSeats).toBe(2);
    expect(a.offerPending).toBe(true);
  });

  it("keeps the offer as a note beside a staffed verdict", () => {
    const a = shiftAttention({ filled: 2, requiredCount: 2, hasOpenOffer: true });
    expect(a.level).toBe("staffed");
    expect(a.offerPending).toBe(true);
  });

  it("never reports negative seats when more people are assigned than required", () => {
    // Capacity can be lowered after people were assigned; the column must not
    // print "-1 open".
    const a = shiftAttention({ filled: 4, requiredCount: 2, hasOpenOffer: false });
    expect(a.level).toBe("staffed");
    expect(a.openSeats).toBe(0);
  });

  it("treats a shift with nobody on it as understaffed", () => {
    expect(shiftAttention({ filled: 0, requiredCount: 1, hasOpenOffer: true }).level).toBe(
      "understaffed"
    );
  });
});

describe("countUnderstaffed", () => {
  it("counts only the shifts still missing someone", () => {
    const rows = [
      shiftAttention({ filled: 0, requiredCount: 2, hasOpenOffer: true }),
      shiftAttention({ filled: 2, requiredCount: 2, hasOpenOffer: true }),
      shiftAttention({ filled: 1, requiredCount: 4, hasOpenOffer: false }),
    ];
    expect(countUnderstaffed(rows)).toBe(2);
  });

  it("is zero for an all-staffed list", () => {
    expect(countUnderstaffed([shiftAttention({ filled: 1, requiredCount: 1, hasOpenOffer: false })])).toBe(0);
  });
});
