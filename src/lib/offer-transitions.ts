/**
 * Which response changes an employee may make on an open offer.
 *
 * Pure and tested so the rule is stated once and can be read at a glance.
 * Deliberately permissive while the offer is open: someone who declined by
 * mistake can say yes again, which costs one table entry here and saves a
 * phone call to dispatch. What it never allows is going back to `pending`
 * (that is the system's initial state, not a choice) or withdrawing interest
 * that was never expressed.
 *
 * Approval is not modelled here at all — B4 records it with decided_at and a
 * resulting assignment, never as a response state the employee could set.
 */

export const EMPLOYEE_RESPONSES = ["interested", "declined", "withdrawn"] as const;
export type EmployeeResponse = (typeof EMPLOYEE_RESPONSES)[number];

export type ResponseState = "pending" | EmployeeResponse;

const ALLOWED: Record<ResponseState, readonly EmployeeResponse[]> = {
  pending: ["interested", "declined"],
  interested: ["declined", "withdrawn"],
  declined: ["interested"],
  withdrawn: ["interested", "declined"],
};

export function isEmployeeResponse(value: string): value is EmployeeResponse {
  return (EMPLOYEE_RESPONSES as readonly string[]).includes(value);
}

/** True when `to` is a legal move from `from`. Same-state is handled by callers. */
export function canTransition(from: ResponseState, to: EmployeeResponse): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export type TransitionOutcome =
  | { kind: "changed"; to: EmployeeResponse }
  | { kind: "unchanged" }
  | { kind: "not_allowed" };

/**
 * Classify a requested change. Repeating the current state is `unchanged`, so
 * a double click or a retried request is harmless and notifies nobody.
 */
export function classifyTransition(
  from: ResponseState,
  to: EmployeeResponse
): TransitionOutcome {
  if (from === to) return { kind: "unchanged" };
  return canTransition(from, to) ? { kind: "changed", to } : { kind: "not_allowed" };
}
