import { describe, expect, it } from "vitest";
import {
  EMPLOYMENT_STATUSES,
  SCHEDULABLE_STATUSES,
  isSchedulable,
  classifyStatusChange,
  deactivates,
  EMPLOYEE_FIELDS,
  SELF_EDITABLE_FIELDS,
  HR_EDITABLE_FIELDS,
  canEdit,
  filterEditableFields,
  SENSITIVE_FIELDS,
  changedFieldNames,
  accountState,
  countsForDate,
  expiresSoon,
  classifyAvailability,
  summariseConflicts,
} from "@/lib/employee";

describe("employment status", () => {
  it("only active and probation may be scheduled", () => {
    expect(isSchedulable("active")).toBe(true);
    expect(isSchedulable("probation")).toBe(true);
    expect(isSchedulable("on_leave")).toBe(false);
    expect(isSchedulable("terminated")).toBe(false);
    expect([...SCHEDULABLE_STATUSES]).toEqual(["active", "probation"]);
  });

  it("covers every status the enum has, so a new one cannot be silently schedulable", () => {
    expect([...EMPLOYMENT_STATUSES]).toEqual(["active", "probation", "on_leave", "terminated"]);
    for (const status of EMPLOYMENT_STATUSES) {
      expect(typeof isSchedulable(status)).toBe("boolean");
    }
  });

  it("allows any transition — people are re-hired and mistakes are corrected", () => {
    expect(classifyStatusChange("terminated", "active")).toEqual({
      kind: "allowed",
      from: "terminated",
      to: "active",
    });
    expect(classifyStatusChange("active", "on_leave")).toEqual({
      kind: "allowed",
      from: "active",
      to: "on_leave",
    });
  });

  it("refuses a no-op, so a double submit writes no second audit row", () => {
    expect(classifyStatusChange("active", "active")).toEqual({
      kind: "refused",
      reason: "unchanged",
    });
  });

  it("refuses a status that is not in the enum", () => {
    expect(classifyStatusChange("active", "retired")).toEqual({
      kind: "refused",
      reason: "invalid_status",
    });
  });

  it("knows which changes create a scheduling conflict to show", () => {
    expect(deactivates("active", "terminated")).toBe(true);
    expect(deactivates("probation", "on_leave")).toBe(true);
    expect(deactivates("terminated", "active")).toBe(false);
    expect(deactivates("on_leave", "terminated")).toBe(false);
  });
});

describe("field ownership", () => {
  it("the employee owns exactly one column of this table", () => {
    expect(SELF_EDITABLE_FIELDS).toEqual(["phone"]);
  });

  it("every employment-authoritative field belongs to HR", () => {
    for (const field of [
      "employee_no",
      "full_name",
      "email",
      "position",
      "department_id",
      "location_id",
      "employment_status",
      "contract_type",
      "start_date",
      "weekly_hours",
      "hourly_rate",
      "vacation_days_total",
      "vacation_days_used",
    ]) {
      expect(EMPLOYEE_FIELDS[field as keyof typeof EMPLOYEE_FIELDS]).toBe("hr");
      expect(canEdit(field, "employee")).toBe(false);
      expect(canEdit(field, "hr")).toBe(true);
    }
    expect(HR_EDITABLE_FIELDS).toHaveLength(13);
  });

  it("identity and linkage belong to nobody", () => {
    for (const field of ["id", "company_id", "profile_id", "created_at", "updated_at", "photo_url"]) {
      expect(EMPLOYEE_FIELDS[field as keyof typeof EMPLOYEE_FIELDS]).toBe("system");
      expect(canEdit(field, "hr")).toBe(false);
      expect(canEdit(field, "employee")).toBe(false);
    }
  });

  it("an unknown column is immutable by default, for both actors", () => {
    expect(canEdit("iban", "hr")).toBe(false);
    expect(canEdit("iban", "employee")).toBe(false);
  });

  it("filters a patch rather than rejecting the whole save", () => {
    expect(
      filterEditableFields(
        { phone: "030 111", hourly_rate: 99, employment_status: "active" },
        "employee"
      )
    ).toEqual({
      accepted: { phone: "030 111" },
      rejected: ["hourly_rate", "employment_status"],
    });
  });

  it("HR may write their own fields and the employee's too", () => {
    expect(filterEditableFields({ phone: "1", hourly_rate: 20, id: "x" }, "hr")).toEqual({
      accepted: { phone: "1", hourly_rate: 20 },
      rejected: ["id"],
    });
  });
});

describe("audit field names", () => {
  it("reports which fields moved, in a stable order", () => {
    expect(
      changedFieldNames({ position: "a", phone: "1", weekly_hours: 40 }, { position: "b", phone: "1" })
    ).toEqual(["position"]);
  });

  it("names the sensitive fields but never needs their values", () => {
    const names = changedFieldNames({ hourly_rate: 18, email: "a@b.c" }, { hourly_rate: 22, email: "x@y.z" });
    expect(names).toEqual(["email", "hourly_rate"]);
    for (const field of SENSITIVE_FIELDS) {
      expect(names.includes(field) || field === "phone").toBe(true);
    }
    // The point of the function: it returns names, so no value can leak through it.
    expect(JSON.stringify(names)).not.toContain("22");
    expect(JSON.stringify(names)).not.toContain("x@y.z");
  });
});

describe("account state", () => {
  it("an employee record with no linked profile has no account", () => {
    expect(accountState(null, null)).toBe("no_account");
    expect(accountState(null, "active")).toBe("no_account");
  });

  it("a linked profile is active or invited by its membership", () => {
    expect(accountState("p1", "active")).toBe("active");
    expect(accountState("p1", "invited")).toBe("invited");
    expect(accountState("p1", null)).toBe("invited");
  });
});

describe("qualifications", () => {
  it("counts only a valid, unexpired qualification", () => {
    expect(countsForDate({ status: "valid", expiresAt: null }, "2026-09-01")).toBe(true);
    expect(countsForDate({ status: "valid", expiresAt: "2026-09-01" }, "2026-09-01")).toBe(true);
    expect(countsForDate({ status: "valid", expiresAt: "2026-08-31" }, "2026-09-01")).toBe(false);
    expect(countsForDate({ status: "expiring", expiresAt: null }, "2026-09-01")).toBe(false);
    expect(countsForDate({ status: "expired", expiresAt: null }, "2026-09-01")).toBe(false);
  });

  it("flags an approaching expiry but not one already past", () => {
    expect(expiresSoon("2026-09-15", "2026-09-01")).toBe(true);
    expect(expiresSoon("2026-12-01", "2026-09-01")).toBe(false);
    expect(expiresSoon("2026-08-01", "2026-09-01")).toBe(false);
    expect(expiresSoon(null, "2026-09-01")).toBe(false);
  });
});

describe("availability", () => {
  it("accepts a recurring weekday rule and an all-day one", () => {
    expect(
      classifyAvailability({ weekday: 3, startTime: "08:00", endTime: "16:00", type: "unavailable" })
    ).toEqual({ kind: "allowed" });
    expect(
      classifyAvailability({ weekday: null, startTime: null, endTime: null, type: "available" })
    ).toEqual({ kind: "allowed" });
  });

  it("refuses an inverted range, which the loader would silently ignore", () => {
    expect(
      classifyAvailability({ weekday: 1, startTime: "16:00", endTime: "08:00", type: "available" })
    ).toEqual({ kind: "refused", reason: "invalid_range" });
    expect(
      classifyAvailability({ weekday: 1, startTime: "08:00", endTime: "08:00", type: "available" })
    ).toEqual({ kind: "refused", reason: "invalid_range" });
  });

  it("refuses a weekday outside 0-6 and an unknown type", () => {
    expect(
      classifyAvailability({ weekday: 7, startTime: null, endTime: null, type: "available" })
    ).toEqual({ kind: "refused", reason: "invalid_weekday" });
    expect(
      classifyAvailability({ weekday: 0, startTime: null, endTime: null, type: "maybe" })
    ).toEqual({ kind: "refused", reason: "invalid_type" });
  });
});

describe("conflicts", () => {
  it("summarises nothing as nothing", () => {
    expect(summariseConflicts([])).toEqual({ count: 0, earliest: null });
  });

  it("reports the count and the soonest date", () => {
    expect(
      summariseConflicts([
        { assignment_id: "a", shift_id: "s1", date: "2026-09-10" },
        { assignment_id: "b", shift_id: "s2", date: "2026-09-03" },
      ])
    ).toEqual({ count: 2, earliest: "2026-09-03" });
  });
});
