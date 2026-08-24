/**
 * Shift lifecycle rules (Phase D) — pure, deterministic, unit-tested.
 *
 * No database, no clock: callers pass rows and `now` in. The server RPCs in
 * 0011 remain authoritative and repeat every concurrency-sensitive check under
 * a lock; this module exists so the rule itself is stated once, as data, and a
 * developer can read the whole policy in one table instead of tracing branches.
 *
 * Two ideas do all the work:
 *
 *   ENGAGEMENT — how far the staffing conversation for this shift has gone.
 *   FIELD RISK — what changing a given field invalidates.
 *
 * The decision is the intersection of the two. Nothing else.
 */

/* ------------------------------------------------------------------ */
/* Engagement                                                          */
/* ------------------------------------------------------------------ */

/**
 * Ordered from least to most committed. Later levels imply the earlier ones:
 * a shift with assignments has also, at some point, had offers.
 */
export const ENGAGEMENT_LEVELS = [
  /** Nobody has been contacted. The shift is still purely a plan. */
  "none",
  /** An open offer exists; nobody has said yes yet. */
  "offered",
  /** Someone has expressed interest and is waiting on a decision. */
  "interested",
  /** At least one employee holds a seat. */
  "assigned",
  /** Time has been recorded against this shift. */
  "worked",
  /** The shift is over. */
  "past",
] as const;

export type Engagement = (typeof ENGAGEMENT_LEVELS)[number];

/** Assignment statuses that mean an employee currently holds a seat. */
export const OCCUPYING = ["assigned", "accepted", "cancellation_requested"] as const;

export type EngagementInput = {
  endTime: Date;
  now: Date;
  hasTimeEntries: boolean;
  occupyingAssignments: number;
  interestedResponses: number;
  hasOpenOffer: boolean;
};

/**
 * The single most committed thing that is true about this shift.
 *
 * Checked most-committed first: a past shift that also has worked time is
 * `past`, because "it is over" is the fact that governs what may still change.
 */
export function classifyEngagement(input: EngagementInput): Engagement {
  if (input.endTime.getTime() <= input.now.getTime()) return "past";
  if (input.hasTimeEntries) return "worked";
  if (input.occupyingAssignments > 0) return "assigned";
  if (input.interestedResponses > 0) return "interested";
  if (input.hasOpenOffer) return "offered";
  return "none";
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

export const EDITABLE_FIELDS = [
  "job_id",
  "start_time",
  "end_time",
  "required_count",
  "required_role",
  "required_qualification",
  "instructions",
  "contact_person",
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

export function isEditableField(value: string): value is EditableField {
  return (EDITABLE_FIELDS as readonly string[]).includes(value);
}

/**
 * What a field change invalidates.
 *
 *   informational — nothing. The work is unchanged; people are told.
 *   capacity      — how many seats. Handled by its own invariant, see below.
 *   eligibility   — who may do this work. Everyone already invited was chosen
 *                   against the old value.
 *   commitment    — what someone agreed to: when it is, and where. The most
 *                   personal of the three.
 */
export type FieldRisk = "informational" | "capacity" | "eligibility" | "commitment";

export const FIELD_RISK: Record<EditableField, FieldRisk> = {
  instructions: "informational",
  contact_person: "informational",
  required_count: "capacity",
  required_role: "eligibility",
  required_qualification: "eligibility",
  start_time: "commitment",
  end_time: "commitment",
  job_id: "commitment",
};

/* ------------------------------------------------------------------ */
/* The matrix                                                          */
/* ------------------------------------------------------------------ */

export type EditRefusal =
  | "shift_ended"
  | "has_time_entries"
  | "has_assignments"
  | "job_locked";

export type EditVerdict =
  | { kind: "allow" }
  /** Permitted, but it invalidates the open offer — the caller must confirm. */
  | { kind: "confirm"; because: "invalidates_open_offer" }
  | { kind: "refuse"; reason: EditRefusal };

const ALLOW: EditVerdict = { kind: "allow" };
const CONFIRM: EditVerdict = { kind: "confirm", because: "invalidates_open_offer" };
const refuse = (reason: EditRefusal): EditVerdict => ({ kind: "refuse", reason });

/**
 * May this one field change at this engagement level?
 *
 * Read the table, not the prose:
 *
 *   field risk      none  offered   interested  assigned          worked   past
 *   informational   allow allow     allow       allow             allow    refuse
 *   capacity        allow allow     allow       allow*            allow*   refuse
 *   eligibility     allow confirm   confirm     refuse            refuse   refuse
 *   commitment      allow confirm   confirm     refuse            refuse   refuse
 *   job_id          allow refuse    refuse      refuse            refuse   refuse
 *
 *   * capacity has a second, independent guard: it may never drop below the
 *     number of people currently holding a seat. See capacityVerdict().
 *
 * `job_id` is stricter than the other commitment fields because the job
 * carries the site: it is the one change that can send someone to a different
 * address. Once anyone has been invited, that is a new shift, not an edit.
 */
export function editVerdict(field: EditableField, engagement: Engagement): EditVerdict {
  if (engagement === "past") return refuse("shift_ended");

  const risk = FIELD_RISK[field];

  if (risk === "informational" || risk === "capacity") return ALLOW;

  // eligibility + commitment from here down
  if (engagement === "worked") return refuse("has_time_entries");
  if (engagement === "assigned") return refuse("has_assignments");

  if (field === "job_id") {
    return engagement === "none" ? ALLOW : refuse("job_locked");
  }

  return engagement === "none" ? ALLOW : CONFIRM;
}

/**
 * The verdict for a whole edit. The strictest field wins: one refusal refuses
 * the edit, and one confirmation requires confirmation for all of it. An edit
 * is a single transaction, so it cannot be partly applied.
 */
export function editSetVerdict(
  fields: readonly EditableField[],
  engagement: Engagement
): EditVerdict {
  let needsConfirm = false;
  for (const field of fields) {
    const verdict = editVerdict(field, engagement);
    if (verdict.kind === "refuse") return verdict;
    if (verdict.kind === "confirm") needsConfirm = true;
  }
  return needsConfirm ? CONFIRM : ALLOW;
}

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

export type CapacityVerdict =
  | { kind: "allow"; opensVacancies: boolean }
  | { kind: "refuse"; reason: "below_occupancy" | "not_positive" };

/**
 * Capacity may rise freely and may fall only to the number of people who
 * already hold a seat.
 *
 * Reducing below occupancy would mean the system choosing whom to drop.
 * It refuses instead: the manager removes someone explicitly through the
 * Phase C.1 workflow — with a reason, an audit entry and a notification — and
 * then reduces the count. Nobody loses a shift as a side effect of arithmetic.
 */
export function capacityVerdict(
  currentCount: number,
  nextCount: number,
  occupancy: number
): CapacityVerdict {
  if (!Number.isInteger(nextCount) || nextCount < 1) {
    return { kind: "refuse", reason: "not_positive" };
  }
  if (nextCount < occupancy) return { kind: "refuse", reason: "below_occupancy" };
  return { kind: "allow", opensVacancies: nextCount > currentCount };
}

/** The status the staffing rule derives. Never chosen by a human. */
export function derivedShiftStatus(
  occupancy: number,
  requiredCount: number
): "open" | "staffed" {
  return occupancy >= requiredCount ? "staffed" : "open";
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export type NotifyAudience = "none" | "engaged";

/**
 * Who hears about an edit.
 *
 * Capacity is the deliberate exception: needing one more person changes
 * nothing about the shift the people already involved agreed to, and telling
 * them teaches them to ignore the next message. Everything else that reaches
 * this point either changes what the work is or where and when it happens.
 */
export function notifyAudience(fields: readonly EditableField[]): NotifyAudience {
  const meaningful = fields.filter((f) => FIELD_RISK[f] !== "capacity");
  return meaningful.length > 0 ? "engaged" : "none";
}

/* ------------------------------------------------------------------ */
/* Diffing                                                             */
/* ------------------------------------------------------------------ */

export type ShiftFieldValue = string | number | null;

/**
 * Which of the submitted fields actually differ from what is stored.
 *
 * A form posts every field every time; without this, opening a shift and
 * pressing Save would count as an edit, notify people and write an audit row
 * describing no change at all.
 */
export function changedFields(
  current: Partial<Record<EditableField, ShiftFieldValue>>,
  patch: Partial<Record<EditableField, ShiftFieldValue>>
): EditableField[] {
  return (Object.keys(patch) as EditableField[])
    .filter(isEditableField)
    .filter((field) => normalize(patch[field]) !== normalize(current[field]));
}

/** Empty text and absent text are the same thing to a human. */
function normalize(value: ShiftFieldValue | undefined): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return value;
}
