import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  OCCUPYING_ASSIGNMENT_STATUSES,
  type CandidateInput,
  type ShiftContext,
  type TimeRange,
} from "@/lib/eligibility";

/**
 * Assembles the input the eligibility engine needs for one shift.
 *
 * Every query runs through the caller's client, so RLS scopes the result to
 * their tenant before any rule is evaluated. The engine itself stays pure —
 * this file only fetches and shapes rows.
 */

/** Sick-leave states that still block scheduling; mirrors eligibility.ts. */
const BLOCKING_SICK_STATUSES = ["reported", "confirmed"] as const;

export type ShiftRow = {
  id: string;
  company_id: string;
  date: string;
  start_time: string;
  end_time: string;
  required_role: string | null;
  required_qualification: string | null;
};

export function toShiftContext(shift: ShiftRow): ShiftContext {
  return {
    id: shift.id,
    companyId: shift.company_id,
    start: new Date(shift.start_time),
    end: new Date(shift.end_time),
    date: shift.date,
    requiredRole: shift.required_role,
    requiredQualification: shift.required_qualification,
  };
}

/**
 * The UTC offset a timestamp was delivered in ("+02:00", "Z", …).
 *
 * employee_availability stores bare `time` values with no timezone, so a
 * window only makes sense relative to the shift it is compared against. Using
 * the shift's own offset keeps both sides on the same clock. A per-company
 * timezone setting would be the proper fix; see the B2 notes.
 */
export function offsetOf(timestamp: string): string {
  const match = timestamp.match(/(Z|[+-]\d{2}:?\d{2})$/);
  if (!match) return "Z";
  return match[1] === "Z" ? "Z" : match[1].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
}

type AvailabilityRow = {
  type: string;
  weekday: number | null;
  valid_from: string | null;
  valid_to: string | null;
  start_time: string | null;
  end_time: string | null;
};

/**
 * Turn an availability rule into the concrete window it covers on `date`,
 * or null when the rule does not apply that day. Times are inclusive of the
 * whole day when unset, which is how an all-day rule is expressed.
 */
export function availabilityWindowForDate(
  row: AvailabilityRow,
  date: string,
  offset: string
): { type: string; range: TimeRange } | null {
  if (row.valid_from && date < row.valid_from) return null;
  if (row.valid_to && date > row.valid_to) return null;

  if (row.weekday !== null) {
    // getUTCDay() on a date-only string is stable: no local-time drift.
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday !== row.weekday) return null;
  }

  const start = new Date(`${date}T${row.start_time ?? "00:00:00"}${offset}`);
  const end = row.end_time
    ? new Date(`${date}T${row.end_time}${offset}`)
    : new Date(`${date}T00:00:00${offset}`);
  if (!row.end_time) end.setUTCDate(end.getUTCDate() + 1); // open end = rest of day

  if (!(start < end)) return null; // ignore inverted or zero-length rules
  return { type: row.type, range: { start, end } };
}

/**
 * Load one CandidateInput per employee in the shift's company.
 *
 * Five batched lookups rather than per-employee queries: the candidate pool is
 * the whole workforce, and N+1 here would be felt immediately.
 */
export async function loadCandidateInputsForShift(
  supabase: SupabaseClient,
  shift: ShiftRow
): Promise<CandidateInput[]> {
  const companyId = shift.company_id;
  const offset = offsetOf(shift.start_time);

  const { data: employees, error } = await supabase
    .from("employees")
    .select("id, company_id, employee_no, full_name, employment_status, position, departments(name)")
    .eq("company_id", companyId)
    .order("employee_no", { ascending: true });
  if (error) throw new Error(`employees: ${error.message}`);

  const rows = (employees ?? []) as unknown as Array<{
    id: string;
    company_id: string;
    employee_no: string;
    full_name: string;
    employment_status: string;
    position: string | null;
    departments: { name: string } | null;
  }>;
  if (rows.length === 0) return [];

  const employeeIds = rows.map((e) => e.id);

  const [qualifications, availability, assignments, vacations, sickLeaves] = await Promise.all([
    supabase
      .from("employee_qualifications")
      .select("employee_id, name, status, expires_at")
      .eq("company_id", companyId)
      .in("employee_id", employeeIds),
    supabase
      .from("employee_availability")
      .select("employee_id, type, weekday, valid_from, valid_to, start_time, end_time")
      .eq("company_id", companyId)
      .in("employee_id", employeeIds),
    // Only statuses that still occupy time — the single source of truth lives
    // in eligibility.ts so this list cannot drift from the staffing trigger.
    supabase
      .from("shift_assignments")
      .select("employee_id, shift_id, shifts!inner(start_time, end_time)")
      .eq("company_id", companyId)
      .in("employee_id", employeeIds)
      .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES]),
    supabase
      .from("vacation_requests")
      .select("employee_id, start_date, end_date")
      .eq("company_id", companyId)
      .eq("status", "approved")
      .in("employee_id", employeeIds)
      .lte("start_date", shift.date)
      .gte("end_date", shift.date),
    supabase
      .from("sick_leaves")
      .select("employee_id, start_date, expected_end_date, status")
      .eq("company_id", companyId)
      .in("status", [...BLOCKING_SICK_STATUSES])
      .in("employee_id", employeeIds)
      .lte("start_date", shift.date),
  ]);

  const byEmployee = <T extends { employee_id: string }>(result: { data: T[] | null }) => {
    const map = new Map<string, T[]>();
    for (const row of result.data ?? []) {
      const list = map.get(row.employee_id) ?? [];
      list.push(row);
      map.set(row.employee_id, list);
    }
    return map;
  };

  const qualificationsBy = byEmployee(qualifications as { data: Array<{ employee_id: string; name: string; status: string; expires_at: string | null }> | null });
  const availabilityBy = byEmployee(availability as { data: Array<{ employee_id: string } & AvailabilityRow> | null });
  const assignmentsBy = byEmployee(assignments as { data: Array<{ employee_id: string; shift_id: string; shifts: { start_time: string; end_time: string } | null }> | null });
  const vacationsBy = byEmployee(vacations as { data: Array<{ employee_id: string; start_date: string; end_date: string }> | null });
  const sickBy = byEmployee(sickLeaves as { data: Array<{ employee_id: string; start_date: string; expected_end_date: string | null; status: string }> | null });

  return rows.map((employee) => ({
    employeeId: employee.id,
    companyId: employee.company_id,
    employeeNo: employee.employee_no,
    fullName: employee.full_name,
    employmentStatus: employee.employment_status,
    position: employee.position,
    departmentName: employee.departments?.name ?? null,
    qualifications: (qualificationsBy.get(employee.id) ?? []).map((q) => ({
      name: q.name,
      status: q.status,
      expiresAt: q.expires_at,
    })),
    availability: (availabilityBy.get(employee.id) ?? [])
      .map((row) => availabilityWindowForDate(row, shift.date, offset))
      .filter((window): window is { type: string; range: TimeRange } => window !== null),
    assignments: (assignmentsBy.get(employee.id) ?? [])
      .filter((a) => a.shifts !== null)
      .map((a) => ({
        shiftId: a.shift_id,
        range: { start: new Date(a.shifts!.start_time), end: new Date(a.shifts!.end_time) },
      })),
    vacations: (vacationsBy.get(employee.id) ?? []).map((v) => ({
      startDate: v.start_date,
      endDate: v.end_date,
    })),
    sickLeaves: (sickBy.get(employee.id) ?? []).map((s) => ({
      startDate: s.start_date,
      endDate: s.expected_end_date,
      status: s.status,
    })),
  }));
}
