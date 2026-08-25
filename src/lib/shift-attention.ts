/**
 * What the planning table must say about one shift.
 *
 * The table previously tested "is there an open offer" FIRST, so a shift with
 * an offer out rendered "Offer sent" and nothing else — hiding the fact that
 * seats were still empty. That is exactly backwards: an offer is an action
 * somebody already took, understaffing is the state that still needs someone.
 *
 * Staffing is the verdict; the offer is a note attached to it. Neither number
 * is computed here — both are passed in from the same counts the table already
 * uses.
 */

export type ShiftAttention = {
  /** The verdict. Understaffing always wins over any in-flight offer. */
  level: "understaffed" | "staffed";
  /** Seats still to fill. Zero when staffed. */
  openSeats: number;
  /** An offer is out. Additional information, never a substitute for `level`. */
  offerPending: boolean;
};

export function shiftAttention({
  filled,
  requiredCount,
  hasOpenOffer,
}: {
  filled: number;
  requiredCount: number;
  hasOpenOffer: boolean;
}): ShiftAttention {
  const openSeats = Math.max(0, requiredCount - filled);
  return {
    level: openSeats > 0 ? "understaffed" : "staffed",
    openSeats,
    offerPending: hasOpenOffer,
  };
}

/** How many of these shifts still need someone. Drives the summary line. */
export function countUnderstaffed(rows: readonly ShiftAttention[]): number {
  return rows.filter((r) => r.level === "understaffed").length;
}
