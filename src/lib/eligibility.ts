/**
 * Shift eligibility — pure, deterministic, unit-tested.
 *
 * Nothing here touches the database or the clock: callers fetch rows under
 * their own RLS and pass them in. That is what lets the same rules run when a
 * manager views candidates and again, against fresh rows, at approval time.
 *
 * All comparisons use raw canonical database values. Localized display labels
 * must never reach these functions — see localizeTerm() in taxonomy.ts, which
 * is display-only.
 */

/** Employment statuses that may still be scheduled. */
const SCHEDULABLE_STATUSES = new Set(["active", "probation"]);

/**
 * Assignment statuses that still occupy the employee's time.
 *
 * Exported because it is the contract for `CandidateInput.assignments`: the
 * query layer filters on exactly these before calling in, and a cancellation
 * only frees the seat once it is approved — matching recalc_shift_staffing().
 */
export const OCCUPYING_ASSIGNMENT_STATUSES = [
  "assigned",
  "accepted",
  "cancellation_requested",
] as const;

/**
 * Sick-leave statuses that still block scheduling.
 *
 * Exported so absence.ts can re-export it rather than keep a second copy:
 * reported blocks as hard as confirmed, and a drifting duplicate of that rule
 * would make an ill employee schedulable on one screen and not another.
 */
export const BLOCKING_SICK_STATUSES = ["reported", "confirmed"] as const;

const BLOCKING_SICK_STATUS_SET: ReadonlySet<string> = new Set(BLOCKING_SICK_STATUSES);

export type IneligibleReason =
  | "not_schedulable"
  | "wrong_company"
  | "role_mismatch"
  | "missing_qualification"
  | "marked_unavailable"
  | "overlapping_assignment"
  | "on_vacation"
  | "on_sick_leave"
  | "already_assigned";

export type ShiftContext = {
  id: string;
  companyId: string;
  /** Absolute shift window. */
  start: Date;
  end: Date;
  /** Calendar date of the shift, YYYY-MM-DD, for date-range comparisons. */
  date: string;
  /** Raw required_role value, or null when the shift accepts anyone. */
  requiredRole: string | null;
  requiredQualification: string | null;
};

export type TimeRange = { start: Date; end: Date };

export type CandidateInput = {
  employeeId: string;
  companyId: string;
  employeeNo: string;
  fullName: string;
  employmentStatus: string;
  /** Raw employees.position value. */
  position: string | null;
  /** Raw departments.name value for the employee's department. */
  departmentName: string | null;
  qualifications: Array<{ name: string; status: string; expiresAt: string | null }>;
  availability: Array<{ type: string; range: TimeRange }>;
  /** Windows this employee already occupies — filter on OCCUPYING_ASSIGNMENT_STATUSES. */
  assignments: Array<{ shiftId: string; range: TimeRange }>;
  /** Approved vacation as inclusive date ranges, YYYY-MM-DD. */
  vacations: Array<{ startDate: string; endDate: string }>;
  /** Open sick leaves; endDate null means still open-ended. */
  sickLeaves: Array<{ startDate: string; endDate: string | null; status: string }>;
};

export type EligibilityResult = {
  employeeId: string;
  employeeNo: string;
  fullName: string;
  eligible: boolean;
  reasons: IneligibleReason[];
  score: number;
};

/** Half-open overlap: shifts that merely touch (14:00 end, 14:00 start) do not. */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Inclusive date-range containment on YYYY-MM-DD strings. */
export function dateWithin(date: string, start: string, end: string | null): boolean {
  if (date < start) return false;
  return end === null || date <= end;
}

/**
 * Compatibility matcher for shifts.required_role.
 *
 * Seeded data is inconsistent: some shifts store a department name
 * ("Logistik & Event"), others a job role ("Servicetechniker/in"). Until the
 * schema settles on one of them, a shift matches if its required role equals
 * either the employee's position or their department name.
 *
 * Deliberately the single place that rule lives, so tightening it later is a
 * one-function change. Comparison is exact on trimmed raw values — never on a
 * localized label.
 */
export function matchesRequiredRole(
  requiredRole: string | null,
  position: string | null,
  departmentName: string | null
): boolean {
  if (requiredRole == null) return true;
  const required = requiredRole.trim();
  if (required === "") return true;
  return required === position?.trim() || required === departmentName?.trim();
}

/** A qualification counts if it is valid and not expired before the shift. */
export function hasValidQualification(
  candidate: CandidateInput,
  requiredQualification: string | null,
  shiftDate: string
): boolean {
  if (requiredQualification == null || requiredQualification.trim() === "") return true;
  const required = requiredQualification.trim();
  return candidate.qualifications.some(
    (q) =>
      q.name.trim() === required &&
      q.status === "valid" &&
      (q.expiresAt === null || q.expiresAt >= shiftDate)
  );
}

/**
 * Evaluate one candidate against one shift.
 *
 * Note on availability: only an explicit `unavailable` window excludes someone.
 * Most employees have no availability rows at all, and treating "no data" as
 * "unavailable" would make every candidate list empty.
 */
export function evaluateCandidate(
  candidate: CandidateInput,
  shift: ShiftContext
): EligibilityResult {
  const reasons: IneligibleReason[] = [];
  const shiftRange: TimeRange = { start: shift.start, end: shift.end };

  if (candidate.companyId !== shift.companyId) reasons.push("wrong_company");
  if (!SCHEDULABLE_STATUSES.has(candidate.employmentStatus)) reasons.push("not_schedulable");

  if (!matchesRequiredRole(shift.requiredRole, candidate.position, candidate.departmentName)) {
    reasons.push("role_mismatch");
  }

  if (!hasValidQualification(candidate, shift.requiredQualification, shift.date)) {
    reasons.push("missing_qualification");
  }

  if (
    candidate.availability.some((a) => a.type === "unavailable" && overlaps(a.range, shiftRange))
  ) {
    reasons.push("marked_unavailable");
  }

  if (candidate.assignments.some((a) => a.shiftId === shift.id)) {
    reasons.push("already_assigned");
  } else if (candidate.assignments.some((a) => overlaps(a.range, shiftRange))) {
    reasons.push("overlapping_assignment");
  }

  if (candidate.vacations.some((v) => dateWithin(shift.date, v.startDate, v.endDate))) {
    reasons.push("on_vacation");
  }

  if (
    candidate.sickLeaves.some(
      (s) =>
        BLOCKING_SICK_STATUS_SET.has(s.status) && dateWithin(shift.date, s.startDate, s.endDate)
    )
  ) {
    reasons.push("on_sick_leave");
  }

  return {
    employeeId: candidate.employeeId,
    employeeNo: candidate.employeeNo,
    fullName: candidate.fullName,
    eligible: reasons.length === 0,
    reasons,
    score: reasons.length === 0 ? score(candidate, shift) : 0,
  };
}

/**
 * Ranking for V1: positive signals only, small and explainable.
 * Workload balancing and overtime rules are deliberately out of scope — they
 * deserve a real design rather than a scoring nudge.
 */
function score(candidate: CandidateInput, shift: ShiftContext): number {
  const shiftRange: TimeRange = { start: shift.start, end: shift.end };
  let total = 0;

  for (const window of candidate.availability) {
    if (!overlaps(window.range, shiftRange)) continue;
    if (window.type === "preferred") total += 2;
    else if (window.type === "available") total += 1;
  }

  if (
    shift.requiredRole != null &&
    candidate.departmentName != null &&
    shift.requiredRole.trim() === candidate.departmentName.trim()
  ) {
    total += 1;
  }

  return total;
}

/**
 * Evaluate every candidate and return them ranked: eligible first, then by
 * score descending, then by employee number ascending so the order is stable
 * across runs and independent of query order.
 */
export function rankCandidates(
  candidates: CandidateInput[],
  shift: ShiftContext
): EligibilityResult[] {
  return candidates
    .map((candidate) => evaluateCandidate(candidate, shift))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return a.employeeNo.localeCompare(b.employeeNo);
    });
}

/** Convenience for callers that only want the assignable people. */
export function eligibleOnly(results: EligibilityResult[]): EligibilityResult[] {
  return results.filter((r) => r.eligible);
}
