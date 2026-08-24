"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission, AuthzError, type AuthContext } from "@/lib/authz";
import { validatedAction, uuid, isoDate } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import {
  EMPLOYMENT_STATUSES,
  classifyStatusChange,
  changedFieldNames,
  filterEditableFields,
  type AssignmentConflict,
} from "@/lib/employee";

/**
 * Employee administration.
 *
 * Every action here requires `employees.manage` — COMPANY_ADMIN and HR_MANAGER,
 * never DISPATCHER. That is checked here, again by app.is_hr() inside the SQL
 * functions, and a third time by the table policies, so a dispatcher who skips
 * this layer entirely still changes nothing.
 *
 * Two things this file deliberately never does:
 *
 *   It never cancels an assignment. Deactivating someone or removing a
 *   qualification returns the future shifts that now disagree with the record;
 *   releasing a person from one is a scheduling act with its own permission, its
 *   own reason field and its own notification — remove_shift_assignment(), from
 *   Phase C.1.
 *
 *   It never writes an employee's account. profile_id, memberships and auth
 *   users belong to Phase G; Phase F creates employment records that may have no
 *   account at all, which is what the schema was built for.
 */

const employeeFieldsSchema = z.object({
  employee_no: z.string().trim().min(1).max(40),
  full_name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(200).nullable(),
  phone: z.string().trim().max(60).nullable(),
  position: z.string().trim().max(120).nullable(),
  department_id: uuid.nullable(),
  location_id: uuid.nullable(),
  contract_type: z.enum(["full_time", "part_time", "mini_job", "temporary"]),
  start_date: isoDate.nullable(),
  weekly_hours: z.number().gte(0).lte(80).nullable(),
  hourly_rate: z.number().gte(0).lte(10_000).nullable(),
});

/** Resolve an employee that must belong to the caller's company. */
async function resolveEmployee(ctx: AuthContext, employeeId: string) {
  const { data: employee } = await ctx.supabase
    .from("employees")
    .select(
      "id, company_id, employee_no, full_name, email, phone, position, department_id, location_id, contract_type, start_date, weekly_hours, hourly_rate, employment_status"
    )
    .eq("id", employeeId)
    .maybeSingle();
  if (!employee || employee.company_id !== ctx.membership.company_id) {
    throw new AuthzError("wrong_tenant", "employee not accessible");
  }
  return employee as Record<string, unknown> & { id: string; employment_status: string };
}

/* ------------------------------------------------------------------------- */
/* Create                                                                     */
/* ------------------------------------------------------------------------- */

export type CreateEmployeeOutcome =
  | { kind: "created"; employeeId: string }
  | { kind: "refused"; reason: "duplicate_employee_no" };

export const createEmployee = validatedAction(
  employeeFieldsSchema.extend({
    employment_status: z.enum(EMPLOYMENT_STATUSES),
  }),
  async (input): Promise<CreateEmployeeOutcome> => {
    const ctx = await requirePermission("employees.manage");

    // No profile_id, no membership, no auth user. An employment record for
    // somebody who has not logged in yet is a legal, first-class state — that is
    // what makes it possible to roster people before Phase G exists.
    const { data: created, error } = await ctx.supabase
      .from("employees")
      .insert({ ...input, company_id: ctx.membership.company_id })
      .select("id")
      .single();

    if (error || !created) {
      if (error?.message?.includes("employees_company_id_employee_no_key")) {
        return { kind: "refused", reason: "duplicate_employee_no" };
      }
      throw new Error(`employee creation failed: ${error?.message}`);
    }

    await writeAudit(ctx, {
      action: "employee.created",
      entity: "employees",
      entityId: created.id,
      // Identifying, not personal: no name, no contact details, no pay.
      diff: {
        employee_no: input.employee_no,
        employment_status: input.employment_status,
        has_account: false,
      },
    });

    revalidatePath("/app/employees");
    return { kind: "created", employeeId: created.id };
  }
);

/* ------------------------------------------------------------------------- */
/* Update                                                                     */
/* ------------------------------------------------------------------------- */

export type UpdateEmployeeOutcome =
  | { kind: "updated"; changed: string[] }
  | { kind: "refused"; reason: "duplicate_employee_no" };

/**
 * Edit the employment record.
 *
 * employment_status is NOT here on purpose — it goes through
 * set_employment_status() because it has consequences a plain field edit does
 * not, and mixing the two would hide them.
 */
export const updateEmployee = validatedAction(
  employeeFieldsSchema.extend({ employeeId: uuid }),
  async (input): Promise<UpdateEmployeeOutcome> => {
    const ctx = await requirePermission("employees.manage");
    const { employeeId, ...fields } = input;
    const before = await resolveEmployee(ctx, employeeId);

    // Belt and braces with the database: the trigger enforces field ownership,
    // this makes an accidentally-widened form fail visibly here first.
    const { accepted } = filterEditableFields(fields, "hr");

    const { error } = await ctx.supabase
      .from("employees")
      .update(accepted)
      .eq("id", employeeId);

    if (error) {
      if (error.message.includes("employees_company_id_employee_no_key")) {
        return { kind: "refused", reason: "duplicate_employee_no" };
      }
      throw new Error(`employee update failed: ${error.message}`);
    }

    const changed = changedFieldNames(before, accepted);
    if (changed.length > 0) {
      await writeAudit(ctx, {
        action: "employee.updated",
        entity: "employees",
        entityId: employeeId,
        // Field NAMES only. Every company admin reads the audit trail, and a
        // pay rate or a phone number copied in there outlives the reason for it.
        diff: { changed_fields: changed },
      });
    }

    revalidatePath("/app/employees");
    revalidatePath(`/app/employees/${employeeId}`);
    return { kind: "updated", changed };
  }
);

/* ------------------------------------------------------------------------- */
/* Employment status                                                          */
/* ------------------------------------------------------------------------- */

export type StatusOutcome =
  | {
      kind: "changed";
      from: string;
      to: string;
      /** Future shifts this employee still holds. Reported, never cancelled. */
      conflicts: AssignmentConflict[];
    }
  | { kind: "refused"; reason: "unchanged" | "invalid_status" | "forbidden" | "not_found" };

export const changeEmploymentStatus = validatedAction(
  z.object({ employeeId: uuid, status: z.enum(EMPLOYMENT_STATUSES) }),
  async (input): Promise<StatusOutcome> => {
    const ctx = await requirePermission("employees.manage");
    const employee = await resolveEmployee(ctx, input.employeeId);

    const verdict = classifyStatusChange(employee.employment_status, input.status);
    if (verdict.kind === "refused") return { kind: "refused", reason: verdict.reason };

    const { data, error } = await ctx.supabase.rpc("set_employment_status", {
      p_employee_id: input.employeeId,
      p_status: input.status,
    });
    if (error) throw new Error(`status change failed: ${error.message}`);

    const result = data as {
      status: string;
      from?: string;
      to?: string;
      conflicts?: AssignmentConflict[];
    };

    if (result.status !== "changed") {
      return {
        kind: "refused",
        reason: result.status as "unchanged" | "invalid_status" | "forbidden" | "not_found",
      };
    }

    // The audit row was written inside the same transaction by the SQL function,
    // so it cannot exist without the change. Nothing is added here.
    revalidatePath("/app/employees");
    revalidatePath(`/app/employees/${input.employeeId}`);
    return {
      kind: "changed",
      from: result.from ?? employee.employment_status,
      to: result.to ?? input.status,
      conflicts: result.conflicts ?? [],
    };
  }
);

/* ------------------------------------------------------------------------- */
/* Qualifications                                                             */
/* ------------------------------------------------------------------------- */

export type QualificationOutcome =
  | { kind: "saved"; qualificationId: string }
  | { kind: "refused"; reason: "not_found" | "forbidden" };

export const saveQualification = validatedAction(
  z.object({
    qualificationId: uuid.optional(),
    employeeId: uuid,
    name: z.string().trim().min(1).max(120),
    issued_at: isoDate.nullable(),
    expires_at: isoDate.nullable(),
    status: z.enum(["valid", "expiring", "expired"]),
  }),
  async (input): Promise<QualificationOutcome> => {
    const ctx = await requirePermission("employees.manage");
    await resolveEmployee(ctx, input.employeeId);

    const row = {
      company_id: ctx.membership.company_id,
      employee_id: input.employeeId,
      name: input.name,
      issued_at: input.issued_at,
      expires_at: input.expires_at,
      status: input.status,
    };

    if (input.qualificationId) {
      const { data, error } = await ctx.supabase
        .from("employee_qualifications")
        .update(row)
        .eq("id", input.qualificationId)
        .select("id");
      if (error) throw new Error(`qualification update failed: ${error.message}`);
      if (!data?.length) return { kind: "refused", reason: "not_found" };

      await writeAudit(ctx, {
        action: "qualification.updated",
        entity: "employee_qualifications",
        entityId: input.qualificationId,
        diff: { employee_id: input.employeeId, name: input.name, expires_at: input.expires_at },
      });
      revalidatePath(`/app/employees/${input.employeeId}`);
      return { kind: "saved", qualificationId: input.qualificationId };
    }

    const { data, error } = await ctx.supabase
      .from("employee_qualifications")
      .insert(row)
      .select("id")
      .single();
    if (error || !data) throw new Error(`qualification insert failed: ${error?.message}`);

    await writeAudit(ctx, {
      action: "qualification.added",
      entity: "employee_qualifications",
      entityId: data.id,
      diff: { employee_id: input.employeeId, name: input.name, expires_at: input.expires_at },
    });
    revalidatePath(`/app/employees/${input.employeeId}`);
    return { kind: "saved", qualificationId: data.id };
  }
);

export type RemoveQualificationOutcome =
  | { kind: "removed"; name: string; conflicts: AssignmentConflict[] }
  | { kind: "refused"; reason: "not_found" | "forbidden" };

/**
 * Remove a qualification and report what it was holding up.
 *
 * Never touches an assignment. If a future shift required this qualification,
 * the person is still committed to it and a human decides what to do — the same
 * rule as deactivation, for the same reason.
 */
export const removeQualification = validatedAction(
  z.object({ qualificationId: uuid, employeeId: uuid }),
  async (input): Promise<RemoveQualificationOutcome> => {
    const ctx = await requirePermission("employees.manage");

    const { data, error } = await ctx.supabase.rpc("remove_qualification", {
      p_qualification_id: input.qualificationId,
    });
    if (error) throw new Error(`qualification removal failed: ${error.message}`);

    const result = data as {
      status: string;
      name?: string;
      conflicts?: AssignmentConflict[];
    };
    if (result.status !== "removed") {
      return { kind: "refused", reason: result.status as "not_found" | "forbidden" };
    }

    revalidatePath(`/app/employees/${input.employeeId}`);
    return { kind: "removed", name: result.name ?? "", conflicts: result.conflicts ?? [] };
  }
);
