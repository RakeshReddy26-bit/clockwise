import { describe, expect, it } from "vitest";
import {
  classifyCancellationRequest,
  classifyDecision,
  isActionable,
  isCancellableStatus,
  restoredAssignmentStatus,
  CANCELLABLE_ASSIGNMENT_STATUSES,
} from "@/lib/cancellation";

const NOW = new Date("2026-09-01T10:00:00Z");
const FUTURE_END = new Date("2026-09-02T16:00:00Z");
const PAST_END = new Date("2026-09-01T09:59:59Z");

function request(over: Partial<Parameters<typeof classifyCancellationRequest>[0]> = {}) {
  return classifyCancellationRequest({
    assignmentStatus: "assigned",
    shiftEnd: FUTURE_END,
    hasPendingRequest: false,
    now: NOW,
    ...over,
  });
}

describe("classifyCancellationRequest", () => {
  it("allows a live assignment on a shift that has not ended", () => {
    expect(request()).toEqual({ kind: "allowed" });
    expect(request({ assignmentStatus: "accepted" })).toEqual({ kind: "allowed" });
  });

  it("refuses a second request while one is still pending", () => {
    expect(request({ hasPendingRequest: true })).toEqual({
      kind: "refused",
      reason: "already_requested",
    });
  });

  it("reports already_requested even once the assignment has moved to cancellation_requested", () => {
    // The first request set both; the honest reason for the second click is
    // the open request, not the status it produced.
    expect(
      request({ assignmentStatus: "cancellation_requested", hasPendingRequest: true })
    ).toEqual({ kind: "refused", reason: "already_requested" });
  });

  it("refuses assignments that are not live", () => {
    for (const status of ["cancelled", "completed", "cancellation_requested"]) {
      expect(request({ assignmentStatus: status })).toEqual({
        kind: "refused",
        reason: "not_cancellable",
      });
    }
  });

  it("refuses once the shift has ended", () => {
    expect(request({ shiftEnd: PAST_END })).toEqual({
      kind: "refused",
      reason: "shift_ended",
    });
  });

  it("treats the exact end instant as ended", () => {
    expect(request({ shiftEnd: NOW })).toEqual({ kind: "refused", reason: "shift_ended" });
  });

  it("still allows a request after the shift has started but before it ends", () => {
    // Someone taken ill mid-shift must still be able to ask; refusing here
    // would push the conversation off-system.
    expect(request({ shiftEnd: new Date("2026-09-01T10:00:01Z") })).toEqual({ kind: "allowed" });
  });

  it("does not read the clock itself", () => {
    const later = new Date("2026-09-03T00:00:00Z");
    expect(request({ now: later })).toEqual({ kind: "refused", reason: "shift_ended" });
  });
});

describe("isCancellableStatus", () => {
  it("accepts exactly the live statuses", () => {
    expect(CANCELLABLE_ASSIGNMENT_STATUSES).toEqual(["assigned", "accepted"]);
    expect(isCancellableStatus("assigned")).toBe(true);
    expect(isCancellableStatus("accepted")).toBe(true);
    expect(isCancellableStatus("cancellation_requested")).toBe(false);
    expect(isCancellableStatus("cancelled")).toBe(false);
    expect(isCancellableStatus("completed")).toBe(false);
  });
});

describe("classifyDecision", () => {
  it("allows a pending request", () => {
    expect(classifyDecision("pending")).toEqual({ kind: "allowed" });
  });

  it("refuses an already decided request in both directions", () => {
    expect(classifyDecision("approved")).toEqual({ kind: "refused", reason: "not_pending" });
    expect(classifyDecision("rejected")).toEqual({ kind: "refused", reason: "not_pending" });
  });
});

describe("restoredAssignmentStatus", () => {
  it("returns accepted only when the employee had accepted", () => {
    expect(restoredAssignmentStatus("2026-08-30T08:00:00Z")).toBe("accepted");
    expect(restoredAssignmentStatus(new Date("2026-08-30T08:00:00Z"))).toBe("accepted");
    expect(restoredAssignmentStatus(null)).toBe("assigned");
  });
});

describe("isActionable", () => {
  it("is true only for pending", () => {
    expect(isActionable("pending")).toBe(true);
    expect(isActionable("approved")).toBe(false);
    expect(isActionable("rejected")).toBe(false);
  });
});
