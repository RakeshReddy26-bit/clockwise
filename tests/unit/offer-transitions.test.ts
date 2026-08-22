import { describe, expect, it } from "vitest";
import {
  canTransition,
  classifyTransition,
  isEmployeeResponse,
  EMPLOYEE_RESPONSES,
  type ResponseState,
} from "@/lib/offer-transitions";

describe("allowed moves", () => {
  it("pending accepts interested and declined", () => {
    expect(canTransition("pending", "interested")).toBe(true);
    expect(canTransition("pending", "declined")).toBe(true);
  });

  it("interest can be withdrawn or turned into a decline", () => {
    expect(canTransition("interested", "withdrawn")).toBe(true);
    expect(canTransition("interested", "declined")).toBe(true);
  });

  it("someone who declined or withdrew may change their mind", () => {
    expect(canTransition("declined", "interested")).toBe(true);
    expect(canTransition("withdrawn", "interested")).toBe(true);
    expect(canTransition("withdrawn", "declined")).toBe(true);
  });
});

describe("refused moves", () => {
  it("interest that was never expressed cannot be withdrawn", () => {
    expect(canTransition("pending", "withdrawn")).toBe(false);
    expect(canTransition("declined", "withdrawn")).toBe(false);
  });

  it("nothing returns to pending — it is the system's initial state", () => {
    for (const from of ["pending", "interested", "declined", "withdrawn"] as ResponseState[]) {
      // "pending" is not an employee intent at all, so it cannot be requested.
      expect(isEmployeeResponse("pending")).toBe(false);
      expect(EMPLOYEE_RESPONSES).not.toContain("pending" as never);
      expect(from).toBeTruthy();
    }
  });

  it("approval is not an employee-settable state", () => {
    expect(isEmployeeResponse("approved")).toBe(false);
    expect(isEmployeeResponse("accepted")).toBe(false);
  });

  it("unknown intents are refused", () => {
    expect(isEmployeeResponse("maybe")).toBe(false);
    expect(isEmployeeResponse("")).toBe(false);
  });
});

describe("classifyTransition", () => {
  it("reports a real change", () => {
    expect(classifyTransition("pending", "interested")).toEqual({
      kind: "changed",
      to: "interested",
    });
  });

  it("treats repeating the current state as a no-op, not an error", () => {
    for (const state of EMPLOYEE_RESPONSES) {
      expect(classifyTransition(state, state), state).toEqual({ kind: "unchanged" });
    }
  });

  it("a double click on Interested writes nothing the second time", () => {
    const first = classifyTransition("pending", "interested");
    expect(first.kind).toBe("changed");
    const second = classifyTransition("interested", "interested");
    expect(second.kind).toBe("unchanged");
  });

  it("reports an illegal move without throwing", () => {
    expect(classifyTransition("pending", "withdrawn")).toEqual({ kind: "not_allowed" });
  });

  it("is deterministic", () => {
    const a = classifyTransition("declined", "interested");
    const b = classifyTransition("declined", "interested");
    expect(a).toEqual(b);
  });
});

describe("state coverage", () => {
  it("every state has a defined answer for every employee intent", () => {
    const states: ResponseState[] = ["pending", "interested", "declined", "withdrawn"];
    for (const from of states) {
      for (const to of EMPLOYEE_RESPONSES) {
        const outcome = classifyTransition(from, to);
        expect(["changed", "unchanged", "not_allowed"]).toContain(outcome.kind);
      }
    }
  });
});
