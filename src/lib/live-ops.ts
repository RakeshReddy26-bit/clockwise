/**
 * What a manager has to deal with, ordered by how much it hurts.
 *
 * Pure and clock-explicit, like the attendance engine it sits on top of. It
 * takes rows the operations page has already loaded and turns them into a
 * ranked list of situations — it issues no queries and reaches no database, so
 * the ordering can be argued about in a unit test rather than in a demo.
 *
 * Nothing here decides anything operational. Staffing comes from
 * `shiftAttention`, attendance from `attendanceStatus`; this module only says
 * which of their outputs deserves the top of the screen.
 *
 * Text is deliberately absent. Every item carries structured values and the
 * component localises them, so the same list reads correctly in German and
 * English without this file knowing either language.
 */

import type { AttendanceStatus } from "@/lib/attendance";

/** Situations the board surfaces. Ordered by severity in `SEVERITY` below. */
export type AttentionKind =
  | "no_show"
  | "understaffed_active"
  | "manual_request"
  | "outside_geofence"
  | "understaffed_upcoming"
  | "late";

/**
 * Lower sorts first.
 *
 * The order is an operational judgement, not an arbitrary one:
 *  - a no-show is a person who is not somewhere they are needed NOW;
 *  - a shift already running below strength is the same problem one step less
 *    acute, because the remaining crew is absorbing it;
 *  - a manual clock-in request is a human waiting on a human, and the wait is
 *    visible to the employee;
 *  - an outside-geofence arrival is recorded and flagged, but the work is
 *    happening;
 *  - a gap in a shift that has not started is real but still has runway;
 *  - a late arrival usually resolves itself within minutes.
 */
const SEVERITY: Record<AttentionKind, number> = {
  no_show: 0,
  understaffed_active: 1,
  manual_request: 2,
  outside_geofence: 3,
  understaffed_upcoming: 4,
  late: 5,
};

type Base = {
  /** Stable across renders so React keys and tests do not depend on order. */
  key: string;
  kind: AttentionKind;
  severity: number;
  siteName: string;
  /** Where "View shift" goes. Null when the item is not about one shift. */
  shiftId: string | null;
};

export type AttentionItem = Base &
  (
    | { kind: "no_show"; employeeName: string; minutesLate: number }
    | { kind: "late"; employeeName: string; minutesLate: number }
    | { kind: "outside_geofence"; employeeName: string; distanceM: number | null }
    | { kind: "manual_request"; employeeName: string; waitingMinutes: number; requestId: string }
    | {
        kind: "understaffed_active" | "understaffed_upcoming";
        required: number;
        filled: number;
        openSeats: number;
        /** Negative once the shift has started. */
        minutesUntilStart: number;
      }
  );

/** One person on today's board, as the operations page already models them. */
export type BoardPerson = {
  assignmentId: string;
  employeeName: string;
  siteName: string;
  shiftId: string | null;
  status: AttendanceStatus;
  minutesLate: number | null;
  distanceM: number | null;
};

/** One shift with its staffing already computed by `shiftAttention`. */
export type BoardShift = {
  shiftId: string;
  siteName: string;
  required: number;
  filled: number;
  openSeats: number;
  startsAt: Date;
};

export type PendingRequest = {
  requestId: string;
  employeeName: string;
  siteName: string;
  shiftId: string | null;
  createdAt: Date;
};

export type AttentionInput = {
  people: BoardPerson[];
  shifts: BoardShift[];
  requests: PendingRequest[];
  now: Date;
};

const MINUTE = 60_000;

/**
 * Build the ranked attention list.
 *
 * `limit` exists because the point of this panel is triage: a list of thirty
 * things is the same as no list. What is dropped is always the least severe,
 * and the caller is told the total so it can say "and 6 more".
 */
export function buildAttentionItems(
  input: AttentionInput,
  limit = 6
): { items: AttentionItem[]; total: number } {
  const items: AttentionItem[] = [];

  for (const person of input.people) {
    const base = {
      siteName: person.siteName,
      shiftId: person.shiftId,
    };

    if (person.status === "no_show") {
      items.push({
        ...base,
        key: `no_show:${person.assignmentId}`,
        kind: "no_show",
        severity: SEVERITY.no_show,
        employeeName: person.employeeName,
        minutesLate: person.minutesLate ?? 0,
      });
    } else if (person.status === "late") {
      items.push({
        ...base,
        key: `late:${person.assignmentId}`,
        kind: "late",
        severity: SEVERITY.late,
        employeeName: person.employeeName,
        minutesLate: person.minutesLate ?? 0,
      });
    } else if (person.status === "outside_geofence") {
      items.push({
        ...base,
        key: `outside:${person.assignmentId}`,
        kind: "outside_geofence",
        severity: SEVERITY.outside_geofence,
        employeeName: person.employeeName,
        distanceM: person.distanceM,
      });
    }
  }

  for (const shift of input.shifts) {
    if (shift.openSeats <= 0) continue;
    const minutesUntilStart = Math.round((shift.startsAt.getTime() - input.now.getTime()) / MINUTE);
    const kind: AttentionKind =
      minutesUntilStart <= 0 ? "understaffed_active" : "understaffed_upcoming";

    items.push({
      key: `understaffed:${shift.shiftId}`,
      kind,
      severity: SEVERITY[kind],
      siteName: shift.siteName,
      shiftId: shift.shiftId,
      required: shift.required,
      filled: shift.filled,
      openSeats: shift.openSeats,
      minutesUntilStart,
    } as AttentionItem);
  }

  for (const request of input.requests) {
    items.push({
      key: `manual:${request.requestId}`,
      kind: "manual_request",
      severity: SEVERITY.manual_request,
      siteName: request.siteName,
      shiftId: request.shiftId,
      employeeName: request.employeeName,
      requestId: request.requestId,
      waitingMinutes: Math.max(
        0,
        Math.round((input.now.getTime() - request.createdAt.getTime()) / MINUTE)
      ),
    });
  }

  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity - b.severity;
    // Within a severity band, the longer something has been wrong, the higher
    // it goes — otherwise the order is whatever the query happened to return.
    return urgencyWithinBand(b) - urgencyWithinBand(a);
  });

  return { items: items.slice(0, limit), total: items.length };
}

/** How long this has been a problem, in minutes. Ties break on this. */
function urgencyWithinBand(item: AttentionItem): number {
  switch (item.kind) {
    case "no_show":
    case "late":
      return item.minutesLate;
    case "manual_request":
      return item.waitingMinutes;
    case "understaffed_active":
      return -item.minutesUntilStart;
    case "understaffed_upcoming":
      // Sooner is more urgent, so invert: a shift in 30 minutes outranks one
      // in six hours.
      return -item.minutesUntilStart;
    case "outside_geofence":
      return item.distanceM ?? 0;
  }
}

/**
 * The one-line question a manager would put to the assistant about this item.
 *
 * Returned as a translation key plus values rather than a sentence: the
 * assistant is asked in the manager's own language, and this module has no
 * business holding either one.
 */
export function askAiPromptKey(item: AttentionItem): string {
  switch (item.kind) {
    case "no_show":
      return "askNoShow";
    case "understaffed_active":
    case "understaffed_upcoming":
      return "askUnderstaffed";
    case "manual_request":
      return "askManualRequest";
    case "outside_geofence":
      return "askOutsideGeofence";
    case "late":
      return "askLate";
  }
}

/** True when the board has nothing that needs a decision. */
export function isAllClear(result: { total: number }): boolean {
  return result.total === 0;
}
