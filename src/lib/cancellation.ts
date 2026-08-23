/**
 * Shift-cancellation rules (Phase C).
 *
 * Pure: no database, no clock, `now` is always injected. The two questions
 * this file answers are "may this employee ask to be released from this
 * assignment?" and "may this pending request still be decided?". Everything
 * concurrency-sensitive — freeing the seat, restoring the assignment — is
 * decided inside decide_cancellation_request() while holding a lock, exactly
 * as B4 does for approval.
 *
 * Deliberately absent: any notion of a deadline or lead time. A late request
 * is still a request; whether it is acceptable is a human judgement the
 * manager makes when deciding, not a rule the system enforces silently.
 */

/** A request may only be raised against an assignment that is still live. */
export const CANCELLABLE_ASSIGNMENT_STATUSES = ["assigned", "accepted"] as const;
export type CancellableStatus = (typeof CANCELLABLE_ASSIGNMENT_STATUSES)[number];

export function isCancellableStatus(status: string): status is CancellableStatus {
  return (CANCELLABLE_ASSIGNMENT_STATUSES as readonly string[]).includes(status);
}

export type RequestRefusal =
  /** One is already open on this assignment — asking twice changes nothing. */
  | "already_requested"
  /** Already cancelled, completed, or never live. */
  | "not_cancellable"
  /** The shift is over; there is nothing left to be released from. */
  | "shift_ended";

export type RequestOutcome =
  | { kind: "allowed" }
  | { kind: "refused"; reason: RequestRefusal };

/**
 * May this employee raise a cancellation request?
 *
 * `hasPendingRequest` is checked first so a double click or a retried form
 * post reports the honest reason ("you already asked") rather than the
 * side effect of the first request having moved the assignment status.
 */
export function classifyCancellationRequest(input: {
  assignmentStatus: string;
  shiftEnd: Date;
  hasPendingRequest: boolean;
  now: Date;
}): RequestOutcome {
  if (input.hasPendingRequest) {
    return { kind: "refused", reason: "already_requested" };
  }
  if (!isCancellableStatus(input.assignmentStatus)) {
    return { kind: "refused", reason: "not_cancellable" };
  }
  if (input.shiftEnd.getTime() <= input.now.getTime()) {
    return { kind: "refused", reason: "shift_ended" };
  }
  return { kind: "allowed" };
}

export type DecisionRefusal = "not_pending";

export type DecisionOutcome =
  | { kind: "allowed" }
  | { kind: "refused"; reason: DecisionRefusal };

/**
 * May this request still be decided? A decided request is final in both
 * directions, so a second Approve/Reject click is refused rather than
 * silently repeated.
 */
export function classifyDecision(requestStatus: string): DecisionOutcome {
  return requestStatus === "pending"
    ? { kind: "allowed" }
    : { kind: "refused", reason: "not_pending" };
}

/**
 * Where a rejected request puts the assignment back.
 *
 * `cancellation_requested` is a parking state, not a history entry — the
 * assignment has to return to what it was. `accepted_at` is the only durable
 * record of the employee having accepted, so it is what the restore reads.
 */
export function restoredAssignmentStatus(acceptedAt: string | Date | null): CancellableStatus {
  return acceptedAt ? "accepted" : "assigned";
}

/**
 * A request is worth showing to a manager as actionable only while pending.
 * Kept here so the manager list and the decision path agree on one rule.
 */
export function isActionable(requestStatus: string): boolean {
  return requestStatus === "pending";
}
