/**
 * Absence rules (Phase E) — pure, no database, no clock.
 *
 * Vacation and sick leave are deliberately NOT symmetrical, and the asymmetry
 * is the domain rather than an oversight:
 *
 *   Vacation is a REQUEST. It blocks scheduling only once someone approves it,
 *   and approving it while the employee is still on a shift is refused — a
 *   human releases them first, through the Phase C.1 removal that records a
 *   reason and reopens the vacancy.
 *
 *   Sickness is a FACT. Reporting it blocks scheduling immediately and can
 *   never be refused because a shift exists. The conflict is surfaced to a
 *   manager instead; nobody is taken off a shift automatically.
 *
 * Date ranges are inclusive at both ends, matching the existing eligibility
 * engine (eligibility.ts:93) and `check (end_date >= start_date)` in 0001.
 * Comparison is always against shifts.date, which 0011 derives in
 * Europe/Berlin — this module introduces no second date convention.
 */

import {
  BLOCKING_SICK_STATUSES,
  OCCUPYING_ASSIGNMENT_STATUSES,
} from "./eligibility";

/* ------------------------------------------------------------------ */
/* Vacation                                                            */
/* ------------------------------------------------------------------ */

export const VACATION_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type VacationStatus = (typeof VACATION_STATUSES)[number];

/** Only an approved request keeps someone off the schedule. */
export const BLOCKING_VACATION_STATUSES = ["approved"] as const;

export function vacationBlocksScheduling(status: string): boolean {
  return (BLOCKING_VACATION_STATUSES as readonly string[]).includes(status);
}

export type VacationDecision = "approve" | "reject";

export type VacationTransition =
  | { kind: "allowed"; to: VacationStatus }
  | { kind: "refused"; reason: "not_pending" };

/**
 * A decision is only ever made once. Everything after `pending` is terminal,
 * so a second click, a retried request and a stale browser tab all land on the
 * same honest refusal rather than a second decision.
 */
export function classifyVacationDecision(
  current: string,
  decision: VacationDecision
): VacationTransition {
  if (current !== "pending") return { kind: "refused", reason: "not_pending" };
  return { kind: "allowed", to: decision === "approve" ? "approved" : "rejected" };
}

/**
 * Withdrawal is the employee's own act and only while nobody has decided.
 * It produces `cancelled` — never a DELETE, and never `rejected`, which would
 * put a manager's name on a decision they never made.
 */
export function classifyVacationWithdrawal(current: string): VacationTransition {
  if (current !== "pending") return { kind: "refused", reason: "not_pending" };
  return { kind: "allowed", to: "cancelled" };
}

/* ------------------------------------------------------------------ */
/* Sick leave                                                          */
/* ------------------------------------------------------------------ */

export const SICK_STATUSES = ["reported", "confirmed", "closed"] as const;
export type SickStatus = (typeof SICK_STATUSES)[number];

/**
 * Reported blocks as hard as confirmed. Confirmation records that a
 * certificate arrived; it is not what makes the person unwell, and waiting for
 * it would keep an ill employee schedulable.
 *
 * Re-exported from the eligibility engine rather than restated. There is one
 * list; a second copy that drifted would make the same employee blocked on the
 * candidate list and schedulable at approval time.
 */
export { BLOCKING_SICK_STATUSES };

export function sickBlocksScheduling(status: string): boolean {
  return (BLOCKING_SICK_STATUSES as readonly string[]).includes(status);
}

export type SickTransition =
  | { kind: "allowed"; to: SickStatus }
  | { kind: "refused"; reason: "already_closed" | "not_a_transition" };

/**
 * reported → confirmed → closed, and reported → closed directly for the common
 * case of a short illness nobody ever documented. There is no rejection: an
 * employer does not decline an illness, and the schema has no state for it.
 */
export function classifySickTransition(current: string, to: string): SickTransition {
  if (current === "closed") return { kind: "refused", reason: "already_closed" };
  if (to === "confirmed" && current === "reported") return { kind: "allowed", to: "confirmed" };
  if (to === "closed" && (current === "reported" || current === "confirmed")) {
    return { kind: "allowed", to: "closed" };
  }
  return { kind: "refused", reason: "not_a_transition" };
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** Inclusive at both ends; a null end means open-ended, as sick leave may be. */
export function coversDate(date: string, start: string, end: string | null): boolean {
  if (date < start) return false;
  return end === null || date <= end;
}

/** Two inclusive ranges touching at all. A null end extends to infinity. */
export function rangesOverlap(
  aStart: string,
  aEnd: string | null,
  bStart: string,
  bEnd: string | null
): boolean {
  if (aEnd !== null && bStart > aEnd) return false;
  if (bEnd !== null && aStart > bEnd) return false;
  return true;
}

export type RequestRefusal = "invalid_range" | "in_the_past" | "overlaps_existing";

export type RequestOutcome = { kind: "allowed" } | { kind: "refused"; reason: RequestRefusal };

/**
 * May this vacation request be submitted?
 *
 * `today` is injected. A request that starts today is allowed — someone
 * arranging leave the same morning is ordinary, and the manager decides.
 */
export function classifyVacationRequest(input: {
  start: string;
  end: string;
  today: string;
  existing: Array<{ start: string; end: string; status: string }>;
}): RequestOutcome {
  if (input.end < input.start) return { kind: "refused", reason: "invalid_range" };
  if (input.start < input.today) return { kind: "refused", reason: "in_the_past" };

  // Only live requests collide. A rejected or withdrawn one is history and must
  // not stop the employee asking again for the same days.
  const live = input.existing.filter(
    (e) => e.status === "pending" || e.status === "approved"
  );
  if (live.some((e) => rangesOverlap(input.start, input.end, e.start, e.end))) {
    return { kind: "refused", reason: "overlaps_existing" };
  }
  return { kind: "allowed" };
}

/** Whole days, inclusive — 1 for a single day. Not a balance, just a count. */
export function daysBetweenInclusive(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/* ------------------------------------------------------------------ */
/* Conflicts with existing assignments                                 */
/* ------------------------------------------------------------------ */

export type AssignmentLike = { id: string; shiftDate: string; status: string };

/**
 * The assignment statuses that still hold a seat. Re-exported from the
 * eligibility engine — the same list also governs recalc_shift_staffing(), and
 * Phase C settled that requesting cancellation does not release the seat.
 */
export { OCCUPYING_ASSIGNMENT_STATUSES };

/**
 * Which of an employee's live assignments fall inside an absence.
 *
 * For vacation this decides whether approval is refused; for sick leave the
 * same list is what the manager is shown. One function, two readings — the
 * difference in what happens next is policy, not arithmetic.
 */
export function conflictingAssignments(
  absence: { start: string; end: string | null },
  assignments: readonly AssignmentLike[]
): AssignmentLike[] {
  return assignments.filter(
    (a) =>
      (OCCUPYING_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status) &&
      coversDate(a.shiftDate, absence.start, absence.end)
  );
}
