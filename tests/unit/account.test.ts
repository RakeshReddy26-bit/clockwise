import { describe, expect, it } from "vitest";
import {
  availableActions,
  canPerform,
  classifyInvite,
  isExistingAccountError,
  employmentAllowsAccess,
  accessEffect,
  ACCESS_ALLOWED_STATUSES,
} from "@/lib/account";

describe("what to offer next", () => {
  it("gives each state exactly one sensible move", () => {
    expect(availableActions("no_account")).toEqual(["invite"]);
    expect(availableActions("invited")).toEqual(["resend"]);
    expect(availableActions("active")).toEqual(["suspend"]);
    expect(availableActions("suspended")).toEqual(["reactivate"]);
  });
});

describe("who may act", () => {
  it("HR invites and resends but never suspends", () => {
    expect(canPerform("invite", "HR_MANAGER")).toBe(true);
    expect(canPerform("resend", "HR_MANAGER")).toBe(true);
    expect(canPerform("suspend", "HR_MANAGER")).toBe(false);
    expect(canPerform("reactivate", "HR_MANAGER")).toBe(false);
  });

  it("company administration does everything", () => {
    for (const role of ["COMPANY_ADMIN", "SUPER_ADMIN"]) {
      for (const action of ["invite", "resend", "suspend", "reactivate"] as const) {
        expect(canPerform(action, role)).toBe(true);
      }
    }
  });

  it("dispatch and employees administer nothing", () => {
    for (const role of ["DISPATCHER", "EMPLOYEE", "APPLICANT"]) {
      for (const action of ["invite", "resend", "suspend", "reactivate"] as const) {
        expect(canPerform(action, role)).toBe(false);
      }
    }
  });
});

describe("invitation preconditions", () => {
  const base = { profileId: null, email: "a@b.test", employmentStatus: "active" };

  it("allows a linked-less employee with an address", () => {
    expect(classifyInvite(base)).toEqual({ kind: "allowed" });
    expect(classifyInvite({ ...base, employmentStatus: "probation" })).toEqual({ kind: "allowed" });
    expect(classifyInvite({ ...base, employmentStatus: "on_leave" })).toEqual({ kind: "allowed" });
  });

  it("refuses one that already has an account", () => {
    expect(classifyInvite({ ...base, profileId: "p1" })).toEqual({
      kind: "refused",
      reason: "already_linked",
    });
  });

  it("refuses a missing or blank address", () => {
    expect(classifyInvite({ ...base, email: null })).toEqual({
      kind: "refused",
      reason: "no_email",
    });
    expect(classifyInvite({ ...base, email: "   " })).toEqual({
      kind: "refused",
      reason: "no_email",
    });
  });

  it("refuses someone who has left — credentials on the way out are backwards", () => {
    expect(classifyInvite({ ...base, employmentStatus: "terminated" })).toEqual({
      kind: "refused",
      reason: "not_employed",
    });
  });
});

describe("recognising an address that already has an account", () => {
  it("matches the codes and the message Supabase uses", () => {
    expect(isExistingAccountError({ code: "email_exists" })).toBe(true);
    expect(isExistingAccountError({ code: "user_already_exists" })).toBe(true);
    expect(isExistingAccountError({ message: "A user with this email address has already been registered" })).toBe(true);
    expect(isExistingAccountError({ message: "User already exists" })).toBe(true);
  });

  it("does not swallow unrelated failures", () => {
    expect(isExistingAccountError({ message: "network error" })).toBe(false);
    expect(isExistingAccountError({ code: "over_email_send_rate_limit" })).toBe(false);
    expect(isExistingAccountError({})).toBe(false);
  });
});

describe("access follows employment", () => {
  it("only leaving the company closes the door", () => {
    expect([...ACCESS_ALLOWED_STATUSES]).toEqual(["active", "probation", "on_leave"]);
    expect(employmentAllowsAccess("on_leave")).toBe(true);
    expect(employmentAllowsAccess("terminated")).toBe(false);
  });

  it("terminating suspends, and coming back reopens", () => {
    expect(accessEffect("active", "terminated")).toBe("suspend");
    expect(accessEffect("on_leave", "terminated")).toBe("suspend");
    expect(accessEffect("terminated", "active")).toBe("reactivate");
    expect(accessEffect("terminated", "probation")).toBe("reactivate");
  });

  it("moves within employment leave access alone", () => {
    expect(accessEffect("active", "on_leave")).toBe("none");
    expect(accessEffect("probation", "active")).toBe("none");
    expect(accessEffect("on_leave", "probation")).toBe("none");
  });
});
