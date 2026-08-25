/**
 * Employee rules (Phase F) — pure, no database, no clock.
 *
 * The thing this module exists to make obvious is WHO OWNS A FIELD. Three
 * answers, and EMPLOYEE_FIELDS below is the single place they are written down:
 *
 *   "hr"       employment data — status, contract, hours, pay, position,
 *              department, location, employee number, name, email. HR here means
 *              COMPANY_ADMIN + HR_MANAGER (app.is_hr). DISPATCHER reads it all
 *              and writes none of it.
 *
 *   "employee" exactly one column on this table: phone. The employee's other
 *              self-service lives in profiles, emergency_contacts and
 *              employee_availability, which are separate rows they own outright.
 *
 *   "system"   id, company_id, profile_id, timestamps. profile_id is set by the
 *              account-linking flow that does not exist yet (Phase G).
 *
 * The database enforces the same split independently — guard_employee_self_
 * mutation() in 0016 compares whole rows as jsonb minus 'phone' — so this list
 * is what the UI reads, never what makes it safe.
 *
 * position and department_id look like description and are not: matchesRequired-
 * Role() compares shifts.required_role against exactly those two values, so a
 * self-editable position would let someone qualify themselves for a restricted
 * shift.
 */

/* ------------------------------------------------------------------ */
/* Employment status                                                   */
/* ------------------------------------------------------------------ */

export const EMPLOYMENT_STATUSES = ["active", "probation", "on_leave", "terminated"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/**
 * Who may still be put on a shift. Identical to SCHEDULABLE_STATUSES in
 * eligibility.ts and to the check inside approve_shift_offer — three copies of
 * one rule, and the tests assert they agree.
 */
export const SCHEDULABLE_STATUSES = ["active", "probation"] as const;

export function isSchedulable(status: string): boolean {
  return (SCHEDULABLE_STATUSES as readonly string[]).includes(status);
}

export function isEmploymentStatus(value: string): value is EmploymentStatus {
  return (EMPLOYMENT_STATUSES as readonly string[]).includes(value);
}

export type StatusChange =
  | { kind: "allowed"; from: EmploymentStatus; to: EmploymentStatus }
  | { kind: "refused"; reason: "unchanged" | "invalid_status" };

/**
 * Any status may follow any other. Deliberately not a state machine: people are
 * re-hired, a termination is entered by mistake and corrected, someone comes
 * back from long leave. Inventing a one-way door here would mean HR could not
 * record what actually happened, which is the opposite of the point.
 *
 * The only refusal is a no-op, so a double-submitted form does not write a
 * second audit row claiming a transition that never occurred.
 */
export function classifyStatusChange(from: string, to: string): StatusChange {
  if (!isEmploymentStatus(to) || !isEmploymentStatus(from)) {
    return { kind: "refused", reason: "invalid_status" };
  }
  if (from === to) return { kind: "refused", reason: "unchanged" };
  return { kind: "allowed", from, to };
}

/**
 * Does this status change take someone off the schedulable list?
 *
 * The only reason it matters is presentation: it decides whether the manager is
 * shown the conflicting future assignments. Becoming schedulable again creates
 * no conflict to resolve.
 */
export function deactivates(from: string, to: string): boolean {
  return isSchedulable(from) && !isSchedulable(to);
}

/* ------------------------------------------------------------------ */
/* Field ownership                                                     */
/* ------------------------------------------------------------------ */

export type FieldOwner = "hr" | "employee" | "system";

/**
 * Every column of public.employees, with its owner.
 *
 * Exhaustive on purpose, and a test asserts it stays exhaustive against the
 * live table. A column added by a later migration and left out of this list is
 * already immutable in the database — the trigger whitelists rather than
 * blocklists — so the failure mode is "nobody can edit it yet", not "everybody
 * can".
 */
export const EMPLOYEE_FIELDS = {
  id: "system",
  company_id: "system",
  profile_id: "system",
  created_at: "system",
  updated_at: "system",
  /** Set by a future upload flow; no storage bucket exists yet. */
  photo_url: "system",

  employee_no: "hr",
  full_name: "hr",
  /** HR's, because the future invitation will be sent to it. */
  email: "hr",
  position: "hr",
  department_id: "hr",
  location_id: "hr",
  employment_status: "hr",
  contract_type: "hr",
  start_date: "hr",
  weekly_hours: "hr",
  hourly_rate: "hr",
  /** Maintained by nothing yet, so not shown anywhere. See risks. */
  vacation_days_total: "hr",
  vacation_days_used: "hr",

  phone: "employee",
} as const satisfies Record<string, FieldOwner>;

export type EmployeeField = keyof typeof EMPLOYEE_FIELDS;

/** The fields an employee may change on their own row. Exactly one, today. */
export const SELF_EDITABLE_FIELDS = (
  Object.keys(EMPLOYEE_FIELDS) as EmployeeField[]
).filter((f) => EMPLOYEE_FIELDS[f] === "employee");

/** The fields HR maintains. Editable by COMPANY_ADMIN and HR_MANAGER only. */
export const HR_EDITABLE_FIELDS = (
  Object.keys(EMPLOYEE_FIELDS) as EmployeeField[]
).filter((f) => EMPLOYEE_FIELDS[f] === "hr");

export function canEdit(field: string, actor: "hr" | "employee"): boolean {
  const owner = (EMPLOYEE_FIELDS as Record<string, FieldOwner>)[field];
  if (owner === undefined) return false; // unknown column: immutable by default
  if (owner === "system") return false;
  return actor === "hr" ? owner === "hr" || owner === "employee" : owner === "employee";
}

/**
 * Which of a submitted patch's keys the actor is actually allowed to write.
 *
 * Returned as accepted/rejected rather than throwing, so a form that grew a new
 * input degrades to "that field was ignored" instead of failing the whole save.
 * The database refuses the rejected ones regardless.
 */
export function filterEditableFields(
  patch: Record<string, unknown>,
  actor: "hr" | "employee"
): { accepted: Record<string, unknown>; rejected: string[] } {
  const accepted: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (canEdit(key, actor)) accepted[key] = value;
    else rejected.push(key);
  }
  return { accepted, rejected };
}

/** Fields whose VALUES must never reach audit_logs — only their names. */
export const SENSITIVE_FIELDS = ["hourly_rate", "phone", "email"] as const;

/**
 * What an employee.updated audit row records: which fields moved, never what
 * they moved to.
 *
 * Every company admin reads the audit trail. A pay rate or a personal phone
 * number copied in there is a disclosure that outlives the reason for it, and
 * the field name already answers the question the trail is for. Same decision
 * as `decision_note_present` in Phase E.
 */
export function changedFieldNames(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  return Object.keys(after)
    .filter((key) => before[key] !== after[key])
    .sort();
}

/* ------------------------------------------------------------------ */
/* Account state                                                       */
/* ------------------------------------------------------------------ */

export type AccountState = "no_account" | "invited" | "active" | "suspended";

/**
 * Derived, not stored. Phase F creates employee records with no account at all
 * (profile_id null), which the schema has always allowed; invitations and
 * linking are Phase G.
 *
 * Worth knowing while reading the manager UI: an 'active' account here means
 * the person can log in, and that is NOT revoked by terminating them —
 * membership status is what gates access, and Phase F deliberately does not
 * touch memberships. The page says so out loud.
 */
export function accountState(
  profileId: string | null,
  membershipStatus: string | null
): AccountState {
  if (profileId === null) return "no_account";
  if (membershipStatus === "active") return "active";
  // Phase G: suspension became a state an operator acts on, so it stops being
  // folded into "invited". A linked profile with no membership row at all is
  // still reported as invited — the invitation created the membership, so its
  // absence means somebody removed it, and "invited" is the honest floor.
  if (membershipStatus === "suspended") return "suspended";
  return "invited";
}

/* ------------------------------------------------------------------ */
/* Qualifications                                                      */
/* ------------------------------------------------------------------ */

export const QUALIFICATION_STATUSES = ["valid", "expiring", "expired"] as const;
export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number];

/**
 * A qualification counts for a shift only if it is 'valid' and not expired
 * before the shift date — the same rule as hasValidQualification() in
 * eligibility.ts, which is what actually gates the candidate list.
 */
export function countsForDate(
  qualification: { status: string; expiresAt: string | null },
  date: string
): boolean {
  if (qualification.status !== "valid") return false;
  return qualification.expiresAt === null || qualification.expiresAt >= date;
}

/** Expiring within `days` of `today`, and not already past. Display only. */
export function expiresSoon(
  expiresAt: string | null,
  today: string,
  days = 60
): boolean {
  if (expiresAt === null || expiresAt < today) return false;
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return expiresAt <= limit;
}

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */

export const AVAILABILITY_TYPES = ["available", "unavailable", "preferred"] as const;
export type AvailabilityType = (typeof AVAILABILITY_TYPES)[number];

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export type AvailabilityDraft = {
  weekday: number | null;
  startTime: string | null;
  endTime: string | null;
  type: string;
};

export type AvailabilityOutcome =
  | { kind: "allowed" }
  | { kind: "refused"; reason: "invalid_weekday" | "invalid_type" | "invalid_range" };

/**
 * Validate one availability rule before it is stored.
 *
 * Matches the semantics availabilityWindowForDate() (candidates.ts) already
 * reads, rather than inventing new ones: a null weekday means every day, a null
 * start means 00:00, a null end means the rest of the day. An inverted range is
 * refused here because the loader silently ignores it — a rule that quietly
 * does nothing is worse than one the form rejected.
 *
 * Note what is NOT validated: overlaps with other rules, and clashes with
 * shifts the employee is already on. Overlapping rules are harmless (only
 * 'unavailable' excludes, and it excludes either way), and an existing
 * commitment is not undone by changing a preference — see the UI copy.
 */
export function classifyAvailability(draft: AvailabilityDraft): AvailabilityOutcome {
  if (!(AVAILABILITY_TYPES as readonly string[]).includes(draft.type)) {
    return { kind: "refused", reason: "invalid_type" };
  }
  if (draft.weekday !== null && !(WEEKDAYS as readonly number[]).includes(draft.weekday)) {
    return { kind: "refused", reason: "invalid_weekday" };
  }
  if (draft.startTime !== null && draft.endTime !== null && draft.endTime <= draft.startTime) {
    return { kind: "refused", reason: "invalid_range" };
  }
  return { kind: "allowed" };
}

/* ------------------------------------------------------------------ */
/* Conflicts                                                           */
/* ------------------------------------------------------------------ */

export type AssignmentConflict = {
  assignment_id: string;
  shift_id: string;
  date: string;
};

/**
 * Both conflict-reporting RPCs return the same shape, and both mean the same
 * thing: these future shifts now disagree with the record, and A PERSON has to
 * decide what to do about them.
 *
 * Nothing here cancels anything. Releasing someone from a shift is a scheduling
 * act with its own permission, its own reason field and its own notification —
 * remove_shift_assignment(), from Phase C.1.
 */
export function summariseConflicts(conflicts: readonly AssignmentConflict[]): {
  count: number;
  earliest: string | null;
} {
  if (conflicts.length === 0) return { count: 0, earliest: null };
  const dates = conflicts.map((c) => c.date).sort();
  return { count: conflicts.length, earliest: dates[0] };
}
