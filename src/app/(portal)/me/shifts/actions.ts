"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireContext, AuthzError, type AuthContext } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import { validatedAction, uuid } from "@/lib/validation";
import {
  evaluateGeofence,
  geofenceSettings,
  shouldSendOutsideAlert,
  type ClockVerification,
} from "@/lib/geofence";
import {
  classifyCancellationRequest,
  type RequestRefusal,
} from "@/lib/cancellation";

/**
 * Geofenced clock-in/out + manual override requests.
 * Server-authoritative: employee, company, assignment, and site are resolved
 * from the session and the database — never from client input. The client
 * sends only raw coordinates; distance is computed here.
 */

const geoFixSchema = z.object({
  lat: z.number().gte(-90).lte(90).optional(),
  lng: z.number().gte(-180).lte(180).optional(),
  accuracyM: z.number().gte(0).lte(100_000).optional(),
});

const ALERT_ROLES = ["COMPANY_ADMIN", "DISPATCHER", "HR_MANAGER"] as const;

type SiteInfo = {
  locationName: string | null;
  site: { lat: number | null; lng: number | null; radiusM: number; enabled: boolean };
};

/** Resolve the caller's employee row (self only). */
async function resolveEmployee(ctx: AuthContext) {
  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("id, full_name, profile_id")
    .eq("company_id", ctx.membership.company_id)
    .eq("profile_id", ctx.userId)
    .maybeSingle();
  if (!employee) throw new AuthzError("forbidden", "no employee record");
  return employee as { id: string; full_name: string; profile_id: string };
}

/** Resolve an assignment that MUST belong to the caller, plus its site. */
async function resolveOwnAssignment(ctx: AuthContext, assignmentId: string, employeeId: string) {
  const { data: assignment } = await ctx.supabase
    .from("shift_assignments")
    .select(
      "id, company_id, employee_id, status, shift_id, shifts(id, start_time, end_time, required_role, jobs(client_name, location_id))"
    )
    .eq("id", assignmentId)
    .maybeSingle();

  if (
    !assignment ||
    assignment.company_id !== ctx.membership.company_id ||
    assignment.employee_id !== employeeId
  ) {
    throw new AuthzError("wrong_tenant", "assignment not accessible");
  }

  const shift = assignment.shifts as unknown as {
    id: string;
    start_time: string;
    end_time: string;
    required_role: string | null;
    jobs: { client_name: string; location_id: string | null } | null;
  };

  let siteInfo: SiteInfo = {
    locationName: null,
    site: { lat: null, lng: null, radiusM: 100, enabled: false },
  };
  const locationId = shift?.jobs?.location_id ?? null;
  if (locationId) {
    const { data: location } = await ctx.supabase
      .from("locations")
      .select("id, company_id, name, lat, lng, geofence_radius_m, geofence_enabled")
      .eq("id", locationId)
      .maybeSingle();
    if (!location || location.company_id !== ctx.membership.company_id) {
      throw new AuthzError("wrong_tenant", "location not accessible");
    }
    siteInfo = {
      locationName: location.name,
      site: {
        lat: location.lat,
        lng: location.lng,
        radiusM: location.geofence_radius_m,
        enabled: location.geofence_enabled,
      },
    };
  }

  return { assignment, shift, ...siteInfo };
}

async function logLocationEvent(
  ctx: AuthContext,
  employeeId: string,
  entry: {
    eventType: string;
    shiftAssignmentId?: string | null;
    timeEntryId?: string | null;
    fix?: { lat?: number; lng?: number; accuracyM?: number };
    distanceM?: number | null;
    allowedRadiusM?: number | null;
  }
) {
  const { error } = await ctx.supabase.from("location_events").insert({
    company_id: ctx.membership.company_id,
    employee_id: employeeId,
    shift_assignment_id: entry.shiftAssignmentId ?? null,
    time_entry_id: entry.timeEntryId ?? null,
    event_type: entry.eventType,
    latitude: entry.fix?.lat ?? null,
    longitude: entry.fix?.lng ?? null,
    accuracy_m: entry.fix?.accuracyM ?? null,
    distance_m: entry.distanceM ?? null,
    allowed_radius_m: entry.allowedRadiusM ?? null,
  });
  if (error) console.error("location_event insert failed:", error.message);
}

/** Staff notification fan-out (service role — employees cannot write these rows). */
async function notifyStaff(
  companyId: string,
  type: string,
  payload: Record<string, unknown>
) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("notifyStaff skipped: SUPABASE_SERVICE_ROLE_KEY not set");
    return;
  }
  try {
    const admin = createAdminClient();
    const { data: staff } = await admin
      .from("company_memberships")
      .select("profile_id, role")
      .eq("company_id", companyId)
      .eq("status", "active")
      .in("role", [...ALERT_ROLES]);
    if (!staff?.length) return;
    await admin.from("notifications").insert(
      staff.map((s) => ({ company_id: companyId, profile_id: s.profile_id, type, payload }))
    );
  } catch (e) {
    console.error("notifyStaff failed:", e);
  }
}

/** Rate limit: one outside-geofence alert per assignment per cooldown window. */
async function outsideAlertAllowed(companyId: string, assignmentId: string): Promise<boolean> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const admin = createAdminClient();
  const [{ data: company }, { data: lastAlert }] = await Promise.all([
    admin.from("companies").select("settings").eq("id", companyId).single(),
    admin
      .from("notifications")
      .select("created_at")
      .eq("company_id", companyId)
      .eq("type", "outside_geofence_attempt")
      .eq("payload->>shift_assignment_id", assignmentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const { alertCooldownMinutes } = geofenceSettings(
    (company?.settings ?? null) as Record<string, unknown> | null
  );
  return shouldSendOutsideAlert(
    lastAlert ? new Date(lastAlert.created_at as string) : null,
    new Date(),
    alertCooldownMinutes
  );
}

export type ClockInResult =
  | { outcome: "clocked_in"; verification: ClockVerification["status"] }
  | { outcome: "outside"; distanceM: number; radiusM: number }
  | { outcome: "location_unavailable" }
  | { outcome: "already_running" }
  /** The shift was cancelled, or the employee removed, moments ago. */
  | { outcome: "assignment_not_active" };

export const clockIn = validatedAction(
  z.object({ shiftAssignmentId: uuid }).merge(geoFixSchema),
  async (input): Promise<ClockInResult> => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);
    const { assignment, locationName, site } = await resolveOwnAssignment(
      ctx,
      input.shiftAssignmentId,
      employee.id
    );

    // 'cancellation_requested' is included deliberately: the seat is still
    // occupied while a manager decides, so the employee is still expected on
    // site and must be able to clock in. Cancelled and completed are not.
    if (!["assigned", "accepted", "cancellation_requested"].includes(assignment.status)) {
      throw new AuthzError("forbidden", "assignment is not active");
    }

    const { data: running } = await ctx.supabase
      .from("time_entries")
      .select("id")
      .eq("employee_id", employee.id)
      .in("status", ["running", "on_break"])
      .limit(1)
      .maybeSingle();
    if (running) return { outcome: "already_running" };

    const fix = { lat: input.lat, lng: input.lng, accuracyM: input.accuracyM };
    const verification = evaluateGeofence(site, fix);

    if (verification.status === "unavailable") {
      await logLocationEvent(ctx, employee.id, {
        eventType: "clock_in_location_unavailable",
        shiftAssignmentId: assignment.id,
        fix,
        allowedRadiusM: site.enabled ? site.radiusM : null,
      });
      return { outcome: "location_unavailable" };
    }

    if (verification.status === "outside_geofence") {
      const allowed = await outsideAlertAllowed(ctx.membership.company_id, assignment.id);
      await logLocationEvent(ctx, employee.id, {
        eventType: "clock_in_outside_geofence",
        shiftAssignmentId: assignment.id,
        fix,
        distanceM: verification.distanceM,
        allowedRadiusM: site.radiusM,
      });
      if (allowed) {
        await notifyStaff(ctx.membership.company_id, "outside_geofence_attempt", {
          shift_assignment_id: assignment.id,
          employee_id: employee.id,
          employee_name: employee.full_name,
          site_name: locationName,
          distance_m: Math.round(verification.distanceM),
          radius_m: site.radiusM,
          attempted_at: new Date().toISOString(),
        });
      }
      return {
        outcome: "outside",
        distanceM: Math.round(verification.distanceM),
        radiusM: site.radiusM,
      };
    }

    // verified or not_required → create the time entry
    const { data: entry, error } = await ctx.supabase
      .from("time_entries")
      .insert({
        company_id: ctx.membership.company_id,
        employee_id: employee.id,
        shift_assignment_id: assignment.id,
        clock_in: new Date().toISOString(),
        source: "app",
        status: "running",
        clock_in_lat: input.lat ?? null,
        clock_in_lng: input.lng ?? null,
        clock_in_accuracy_m: input.accuracyM ?? null,
        clock_in_distance_m:
          verification.status === "verified" ? Math.round(verification.distanceM) : null,
        clock_in_location_status: verification.status,
      })
      .select("id")
      .single();
    if (error || !entry) {
      // guard_time_entry_assignment (0011) refuses a time entry whose
      // assignment is no longer active. The status check above already covers
      // the ordinary case; this fires only when a manager cancelled the shift
      // or removed the employee between that read and this insert.
      if (error?.message?.includes("assignment_not_active")) {
        return { outcome: "assignment_not_active" };
      }
      throw new Error(`clock-in failed: ${error?.message}`);
    }

    if (verification.status === "verified") {
      await logLocationEvent(ctx, employee.id, {
        eventType: "clock_in_verified",
        shiftAssignmentId: assignment.id,
        timeEntryId: entry.id,
        fix,
        distanceM: verification.distanceM,
        allowedRadiusM: site.radiusM,
      });
    }

    revalidatePath("/me/shifts");
    return { outcome: "clocked_in", verification: verification.status };
  }
);

export const clockOut = validatedAction(
  z.object({ timeEntryId: uuid }).merge(geoFixSchema),
  async (input) => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);

    const { data: entry } = await ctx.supabase
      .from("time_entries")
      .select("id, employee_id, company_id, clock_out, shift_assignment_id")
      .eq("id", input.timeEntryId)
      .maybeSingle();
    if (!entry || entry.employee_id !== employee.id || entry.company_id !== ctx.membership.company_id) {
      throw new AuthzError("wrong_tenant", "time entry not accessible");
    }
    if (entry.clock_out) throw new AuthzError("forbidden", "already clocked out");

    // Optional verification — clock-out is NEVER blocked by the geofence.
    let verification: ClockVerification = { status: "not_required", distanceM: null };
    if (entry.shift_assignment_id) {
      try {
        const { site } = await resolveOwnAssignment(ctx, entry.shift_assignment_id, employee.id);
        verification = evaluateGeofence(site, {
          lat: input.lat,
          lng: input.lng,
          accuracyM: input.accuracyM,
        });
        if (verification.status === "outside_geofence") {
          await logLocationEvent(ctx, employee.id, {
            eventType: "clock_out_outside_geofence",
            shiftAssignmentId: entry.shift_assignment_id,
            timeEntryId: entry.id,
            fix: { lat: input.lat, lng: input.lng, accuracyM: input.accuracyM },
            distanceM: verification.distanceM,
            allowedRadiusM: site.radiusM,
          });
        }
      } catch {
        // site lookup failure must never block clock-out
      }
    }

    const { error } = await ctx.supabase
      .from("time_entries")
      .update({
        clock_out: new Date().toISOString(),
        status: "completed",
        clock_out_lat: input.lat ?? null,
        clock_out_lng: input.lng ?? null,
        clock_out_accuracy_m: input.accuracyM ?? null,
        clock_out_distance_m:
          verification.distanceM != null ? Math.round(verification.distanceM) : null,
        clock_out_location_status: verification.status,
      })
      .eq("id", entry.id);
    if (error) throw new Error(`clock-out failed: ${error.message}`);

    revalidatePath("/me/shifts");
    return { outcome: "clocked_out", verification: verification.status };
  }
);

export const requestManualClockIn = validatedAction(
  z
    .object({
      shiftAssignmentId: uuid,
      reason: z.enum([
        "gps_inaccurate",
        "entrance_moved",
        "alternate_location",
        "manager_instructed",
        "other",
      ]),
      reasonNote: z.string().trim().max(500).optional(),
    })
    .merge(geoFixSchema),
  async (input) => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);
    const { assignment, locationName, site } = await resolveOwnAssignment(
      ctx,
      input.shiftAssignmentId,
      employee.id
    );

    const { data: pending } = await ctx.supabase
      .from("manual_clockin_requests")
      .select("id")
      .eq("shift_assignment_id", assignment.id)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    if (pending) return { outcome: "already_pending" as const };

    const verification = evaluateGeofence(site, {
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracyM,
    });

    const { data: request, error } = await ctx.supabase
      .from("manual_clockin_requests")
      .insert({
        company_id: ctx.membership.company_id,
        shift_assignment_id: assignment.id,
        employee_id: employee.id,
        reason: input.reason,
        reason_note: input.reasonNote ?? null,
        latitude: input.lat ?? null,
        longitude: input.lng ?? null,
        accuracy_m: input.accuracyM ?? null,
        distance_m: verification.distanceM != null ? Math.round(verification.distanceM) : null,
      })
      .select("id")
      .single();
    if (error || !request) throw new Error(`manual request failed: ${error?.message}`);

    await logLocationEvent(ctx, employee.id, {
      eventType: "manual_clock_in_requested",
      shiftAssignmentId: assignment.id,
      fix: { lat: input.lat, lng: input.lng, accuracyM: input.accuracyM },
      distanceM: verification.distanceM,
      allowedRadiusM: site.enabled ? site.radiusM : null,
    });

    await notifyStaff(ctx.membership.company_id, "manual_clockin_requested", {
      request_id: request.id,
      shift_assignment_id: assignment.id,
      employee_id: employee.id,
      employee_name: employee.full_name,
      site_name: locationName,
      reason: input.reason,
      distance_m: verification.distanceM != null ? Math.round(verification.distanceM) : null,
    });

    revalidatePath("/me/shifts");
    return { outcome: "requested" as const };
  }
);

/* ------------------------------------------------------------------------- */
/* C2 — employee cancellation request                                         */
/* ------------------------------------------------------------------------- */

/** Statuses request_shift_cancellation() can report. */
type SqlRequestStatus =
  | "requested"
  | "already_requested"
  | "not_cancellable"
  | "shift_ended"
  | "forbidden"
  | "not_found";

export type CancellationRequestOutcome =
  | { kind: "requested" }
  | { kind: "refused"; reason: RequestRefusal };

/**
 * Ask to be released from one of your own shifts.
 *
 * Two layers, the same shape as B4: the rule is evaluated here against freshly
 * loaded rows so the employee gets a specific sentence, then
 * request_shift_cancellation() repeats only what a concurrent transaction
 * could invalidate — while holding the shift lock, and writing the request and
 * the assignment status together.
 *
 * The seat is deliberately NOT freed. Until a manager approves, the assignment
 * still counts toward staffing, so nothing silently uncovers a site.
 */
export const requestShiftCancellation = validatedAction(
  z.object({
    shiftAssignmentId: uuid,
    reason: z.string().trim().min(5).max(500),
  }),
  async (input): Promise<CancellationRequestOutcome> => {
    const ctx = await requireContext();
    const employee = await resolveEmployee(ctx);
    const { assignment, shift } = await resolveOwnAssignment(
      ctx,
      input.shiftAssignmentId,
      employee.id
    );

    const { data: pending } = await ctx.supabase
      .from("cancellation_requests")
      .select("id")
      .eq("shift_assignment_id", assignment.id)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();

    const verdict = classifyCancellationRequest({
      assignmentStatus: assignment.status,
      shiftEnd: new Date(shift.end_time),
      hasPendingRequest: Boolean(pending),
      now: new Date(),
    });
    if (verdict.kind === "refused") return verdict;

    const { data, error } = await ctx.supabase.rpc("request_shift_cancellation", {
      p_assignment_id: assignment.id,
      p_reason: input.reason,
    });
    if (error) throw new Error(`cancellation request failed: ${error.message}`);

    const result = data as { status: SqlRequestStatus; request_id?: string };

    if (result.status !== "requested") {
      switch (result.status) {
        case "already_requested":
          return { kind: "refused", reason: "already_requested" };
        case "shift_ended":
          return { kind: "refused", reason: "shift_ended" };
        case "not_cancellable":
          return { kind: "refused", reason: "not_cancellable" };
        default:
          // forbidden / not_found cannot follow the checks above unless the
          // row moved out from under us; treat as an access problem.
          throw new AuthzError("forbidden", `cancellation refused: ${result.status}`);
      }
    }

    // Reached only on a real transition, so a retry notifies nobody twice.
    await notifyStaff(ctx.membership.company_id, "cancellation_requested", {
      request_id: result.request_id,
      shift_assignment_id: assignment.id,
      shift_id: shift.id,
      employee_id: employee.id,
      employee_name: employee.full_name,
      requested_at: new Date().toISOString(),
    });

    revalidatePath("/me/shifts");
    revalidatePath("/me/requests");
    revalidatePath("/app/shifts");
    return { kind: "requested" };
  }
);
