/**
 * RBAC permission map — pure and unit-tested.
 * JWT/session data is convenience only; authorization always resolves the
 * membership row from the database (see authz.ts) and checks it here.
 */

export const ROLES = [
  "SUPER_ADMIN",
  "COMPANY_ADMIN",
  "HR_MANAGER",
  "DISPATCHER",
  "EMPLOYEE",
  "APPLICANT",
] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "company.manage",
  "members.manage",
  "employees.read",
  "employees.manage",
  "documents.manage",
  "recruitment.manage",
  "scheduling.manage",
  "time.manage",
  "absence.decide",
  "news.manage",
  "notifications.send",
  "self.access",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const STAFF_BASE: Permission[] = ["employees.read", "self.access", "notifications.send"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  COMPANY_ADMIN: PERMISSIONS,
  HR_MANAGER: [
    ...STAFF_BASE,
    "employees.manage",
    "documents.manage",
    "recruitment.manage",
    "absence.decide",
    "news.manage",
  ],
  DISPATCHER: [...STAFF_BASE, "scheduling.manage", "time.manage"],
  EMPLOYEE: ["self.access"],
  APPLICANT: ["self.access"],
};

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles that use the /app manager shell; everyone else lands in /me. */
export function isManagerRole(role: Role): boolean {
  return role === "SUPER_ADMIN" || role === "COMPANY_ADMIN" || role === "HR_MANAGER" || role === "DISPATCHER";
}

export function homePathFor(role: Role): string {
  return isManagerRole(role) ? "/app" : "/me";
}
