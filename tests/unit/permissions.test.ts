import { describe, expect, it } from "vitest";
import {
  ROLES,
  ROLE_PERMISSIONS,
  roleHas,
  isManagerRole,
  homePathFor,
} from "@/lib/permissions";

describe("RBAC permission map", () => {
  it("every role has a permission list", () => {
    for (const role of ROLES) {
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
    }
  });

  it("employees and applicants only get self access", () => {
    expect(ROLE_PERMISSIONS.EMPLOYEE).toEqual(["self.access"]);
    expect(ROLE_PERMISSIONS.APPLICANT).toEqual(["self.access"]);
  });

  it("dispatcher schedules but never touches documents or members", () => {
    expect(roleHas("DISPATCHER", "scheduling.manage")).toBe(true);
    expect(roleHas("DISPATCHER", "time.manage")).toBe(true);
    expect(roleHas("DISPATCHER", "documents.manage")).toBe(false);
    expect(roleHas("DISPATCHER", "members.manage")).toBe(false);
    expect(roleHas("DISPATCHER", "company.manage")).toBe(false);
  });

  it("HR manages people and documents but not company settings", () => {
    expect(roleHas("HR_MANAGER", "employees.manage")).toBe(true);
    expect(roleHas("HR_MANAGER", "documents.manage")).toBe(true);
    expect(roleHas("HR_MANAGER", "absence.decide")).toBe(true);
    expect(roleHas("HR_MANAGER", "company.manage")).toBe(false);
  });

  it("company admin holds every permission", () => {
    expect(roleHas("COMPANY_ADMIN", "company.manage")).toBe(true);
    expect(roleHas("COMPANY_ADMIN", "members.manage")).toBe(true);
    expect(roleHas("COMPANY_ADMIN", "scheduling.manage")).toBe(true);
  });

  it("routes manager roles to /app and everyone else to /me", () => {
    expect(homePathFor("COMPANY_ADMIN")).toBe("/app");
    expect(homePathFor("HR_MANAGER")).toBe("/app");
    expect(homePathFor("DISPATCHER")).toBe("/app");
    expect(homePathFor("EMPLOYEE")).toBe("/me");
    expect(homePathFor("APPLICANT")).toBe("/me");
    expect(isManagerRole("SUPER_ADMIN")).toBe(true);
  });
});
