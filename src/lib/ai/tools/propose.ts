import "server-only";

import { z } from "zod";
import { defineTool, type AiTool } from "@/lib/ai/tools/registry";
import type { AiContext } from "@/lib/ai/context";
import { operatingWallClockToUtc, isWallClockTime } from "@/lib/ai/dates";
import { signProposal, type ProposalPayload } from "@/lib/ai/proposals";
import { OCCUPYING_ASSIGNMENT_STATUSES, rankCandidates } from "@/lib/eligibility";
import { loadCandidateInputsForShift, toShiftContext, type ShiftRow } from "@/lib/candidates";

/**
 * Proposal tools: the assistant's only route towards a write, and it stops short.
 *
 * Each one takes what the model understood from the sentence, resolves it
 * against real tenant rows, validates it, and returns a signed plan plus a
 * human summary. Nothing is written. The manager sees the plan and decides.
 *
 * The division of labour is the point:
 *   model  → "four passenger-service shifts, Ostseekai, tomorrow, 06:00-14:00"
 *   server → which job that is, whether it exists in THIS tenant, whether the
 *            times are valid, what 06:00 means in UTC on that date
 *
 * A name the model invented resolves to nothing and the tool refuses. A site in
 * another company is invisible to the query and resolves to nothing too.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const wallClock = z
  .string()
  .refine(isWallClockTime, "expected a 24-hour time as HH:MM");

/** A proposal tool returns this shape; the runner turns it into a UI card. */
type ProposalToolResult =
  | { status: "proposed"; token: string; expiresAt: number; summary: unknown }
  | { status: "needs_input"; missing: string[]; hint: string }
  | { status: "refused"; reason: string };

function proposed(
  payload: ProposalPayload,
  ctx: AiContext,
  summary: unknown
): ProposalToolResult {
  const signed = signProposal(payload, { userId: ctx.userId, companyId: ctx.companyId });
  return {
    status: "proposed",
    token: signed.token,
    expiresAt: signed.expiresAt,
    summary,
  };
}

/**
 * Turn a site or client name into the job a shift hangs off.
 *
 * Shifts belong to jobs, not to locations, so "at Ostseekai" is only actionable
 * once it names exactly one job. Ambiguity is reported rather than guessed —
 * picking one for the manager is exactly the kind of silent decision this
 * feature must not make.
 */
async function resolveJob(
  ctx: AiContext,
  siteQuery: string
): Promise<
  | { ok: true; jobId: string; label: string }
  | { ok: false; reason: "not_found" | "ambiguous"; options: string[] }
> {
  const { data } = await ctx.auth.supabase
    .from("jobs")
    .select("id, client_name, status, locations(name)")
    .eq("company_id", ctx.companyId)
    .in("status", ["open", "partially_staffed", "fully_staffed"])
    .limit(60);

  const jobs = (data ?? []) as unknown as Array<{
    id: string;
    client_name: string;
    locations: { name: string } | null;
  }>;

  const needle = siteQuery.trim().toLowerCase();
  const matches = jobs.filter(
    (j) =>
      (j.locations?.name ?? "").toLowerCase().includes(needle) ||
      j.client_name.toLowerCase().includes(needle)
  );

  const label = (j: (typeof jobs)[number]) =>
    j.locations?.name ? `${j.locations.name} (${j.client_name})` : j.client_name;

  if (matches.length === 0) {
    return { ok: false, reason: "not_found", options: jobs.slice(0, 10).map(label) };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", options: matches.map(label) };
  }
  return { ok: true, jobId: matches[0].id, label: label(matches[0]) };
}

/* ------------------------------------------------------------------ */
/* Create shifts                                                       */
/* ------------------------------------------------------------------ */

const proposeCreateShifts = defineTool({
  name: "propose_create_shifts",
  kind: "propose",
  permission: "scheduling.manage",
  description:
    "Draft one or more shifts for the manager to confirm. NOTHING IS CREATED by " +
    "this tool. Give the site as the manager said it and local wall-clock times; " +
    "the server resolves the job and the timezone. If the manager did not say " +
    "the site, the time, or how many people are needed, ask them instead of " +
    "inventing a value.",
  schema: z.object({
    site: z.string().trim().min(1).max(120).describe("site or client name as spoken"),
    dates: z.array(isoDate).min(1).max(14).describe("one entry per calendar day"),
    startTime: wallClock.describe("local start, e.g. 06:00"),
    endTime: wallClock.describe("local end, e.g. 14:00"),
    requiredCount: z.number().int().min(1).max(200).describe("workers needed per shift"),
    shiftsPerDay: z.number().int().min(1).max(10).optional().describe("defaults to 1"),
    requiredRole: z.string().trim().max(120).optional(),
    requiredQualification: z.string().trim().max(120).optional(),
  }),
  handler: async (input, ctx): Promise<ProposalToolResult> => {
    const job = await resolveJob(ctx, input.site);
    if (!job.ok) {
      return {
        status: "needs_input",
        missing: ["site"],
        hint:
          job.reason === "not_found"
            ? `No job matches "${input.site}". Available: ${job.options.join(", ") || "none"}.`
            : `"${input.site}" matches several jobs: ${job.options.join(", ")}. Which one?`,
      };
    }

    const perDay = input.shiftsPerDay ?? 1;
    const drafted: Array<{
      jobId: string;
      siteLabel: string;
      date: string;
      startTime: string;
      endTime: string;
      requiredCount: number;
      requiredRole: string | null;
      requiredQualification: string | null;
    }> = [];

    for (const date of input.dates) {
      const start = operatingWallClockToUtc(date, input.startTime);
      let end = operatingWallClockToUtc(date, input.endTime);
      // An end before the start means the shift runs past midnight, which is
      // ordinary in this industry — roll it to the next day rather than refuse.
      if (end <= start) end = operatingWallClockToUtc(addOneDay(date), input.endTime);

      if (end <= start) return { status: "refused", reason: "The end time is not after the start." };
      if (start.getTime() <= Date.now()) {
        return {
          status: "refused",
          reason: `${date} ${input.startTime} is in the past. Shifts must start in the future.`,
        };
      }

      for (let i = 0; i < perDay; i++) {
        drafted.push({
          jobId: job.jobId,
          siteLabel: job.label,
          date,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          requiredCount: input.requiredCount,
          requiredRole: input.requiredRole ?? null,
          requiredQualification: input.requiredQualification ?? null,
        });
      }
    }

    if (drafted.length > 20) {
      return { status: "refused", reason: "That is more than 20 shifts; split the request." };
    }

    return proposed({ kind: "create_shifts", shifts: drafted }, ctx, {
      site: job.label,
      shiftCount: drafted.length,
      dates: input.dates,
      localStart: input.startTime,
      localEnd: input.endTime,
      requiredCount: input.requiredCount,
      role: input.requiredRole ?? null,
    });
  },
});

function addOneDay(isoDateValue: string): string {
  const [y, m, d] = isoDateValue.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Send an offer                                                       */
/* ------------------------------------------------------------------ */

const proposeReplacementOffer = defineTool({
  name: "propose_replacement_offer",
  kind: "propose",
  permission: "scheduling.manage",
  description:
    "Draft a shift offer to specific employees for the manager to confirm. " +
    "NOTHING IS SENT by this tool. Only pass employee ids that " +
    "find_replacement_candidates returned as eligible — this tool re-checks and " +
    "will drop anyone who is not.",
  schema: z.object({
    shiftId: z.string().uuid(),
    employeeIds: z.array(z.string().uuid()).min(1).max(20),
    message: z.string().trim().max(500).optional(),
  }),
  handler: async (input, ctx): Promise<ProposalToolResult> => {
    const { data: shift } = await ctx.auth.supabase
      .from("shifts")
      .select(
        "id, company_id, date, start_time, end_time, status, required_count, required_role, required_qualification, jobs(client_name, locations(name))"
      )
      .eq("company_id", ctx.companyId)
      .eq("id", input.shiftId)
      .maybeSingle();
    if (!shift) return { status: "refused", reason: "That shift does not exist here." };

    const row = shift as unknown as ShiftRow & {
      status: string;
      jobs: { client_name: string; locations: { name: string } | null } | null;
    };
    if (row.status !== "open" && row.status !== "staffed") {
      return { status: "refused", reason: "That shift is no longer open for offers." };
    }

    // Re-run the deterministic engine. The model may have carried a stale id
    // from an earlier turn, and eligibility can change between turns.
    const inputs = await loadCandidateInputsForShift(ctx.auth.supabase, row);
    const ranked = rankCandidates(inputs, toShiftContext(row));
    const byId = new Map(ranked.map((r) => [r.employeeId, r]));

    const accepted: Array<{ employeeId: string; name: string }> = [];
    const dropped: Array<{ employeeId: string; reason: string }> = [];
    for (const id of [...new Set(input.employeeIds)]) {
      const verdict = byId.get(id);
      if (!verdict) {
        dropped.push({ employeeId: id, reason: "not_in_this_company" });
      } else if (!verdict.eligible) {
        dropped.push({ employeeId: id, reason: verdict.reasons[0] ?? "not_schedulable" });
      } else {
        accepted.push({ employeeId: id, name: verdict.fullName });
      }
    }

    if (accepted.length === 0) {
      return {
        status: "refused",
        reason: `None of those people can work this shift: ${dropped
          .map((d) => d.reason)
          .join(", ")}.`,
      };
    }

    const label = `${row.jobs?.locations?.name ?? row.jobs?.client_name ?? "shift"} · ${row.date}`;
    return proposed(
      {
        kind: "send_offer",
        shiftId: row.id,
        shiftLabel: label,
        employees: accepted,
        message: input.message ?? null,
      },
      ctx,
      { shift: label, recipients: accepted.map((a) => a.name), dropped }
    );
  },
});

/* ------------------------------------------------------------------ */
/* Assign an interested responder                                      */
/* ------------------------------------------------------------------ */

const proposeAssignment = defineTool({
  name: "propose_assignment",
  kind: "propose",
  permission: "scheduling.manage",
  description:
    "Draft the assignment of an employee who answered 'interested' to a shift " +
    "offer. NOTHING IS ASSIGNED by this tool. Use list_offer_responses first to " +
    "get the response id.",
  schema: z.object({ responseId: z.string().uuid() }),
  handler: async (input, ctx): Promise<ProposalToolResult> => {
    const { data } = await ctx.auth.supabase
      .from("shift_offer_responses")
      .select(
        "id, response, decided_at, employees(full_name), shift_offers!inner(shifts(date, jobs(client_name, locations(name))))"
      )
      .eq("company_id", ctx.companyId)
      .eq("id", input.responseId)
      .maybeSingle();
    if (!data) return { status: "refused", reason: "That response does not exist here." };

    const row = data as unknown as {
      response: string;
      decided_at: string | null;
      employees: { full_name: string } | null;
      shift_offers: {
        shifts: {
          date: string;
          jobs: { client_name: string; locations: { name: string } | null } | null;
        } | null;
      } | null;
    };

    if (row.decided_at) return { status: "refused", reason: "That response was already decided." };
    if (row.response !== "interested") {
      return { status: "refused", reason: "That person did not say they were interested." };
    }

    const shift = row.shift_offers?.shifts;
    const label = shift
      ? `${shift.jobs?.locations?.name ?? shift.jobs?.client_name ?? "shift"} · ${shift.date}`
      : "shift";

    return proposed(
      {
        kind: "approve_response",
        responseId: input.responseId,
        employeeName: row.employees?.full_name ?? "—",
        shiftLabel: label,
      },
      ctx,
      { employee: row.employees?.full_name ?? "—", shift: label }
    );
  },
});

/* ------------------------------------------------------------------ */
/* Move a shift                                                        */
/* ------------------------------------------------------------------ */

const proposeShiftUpdate = defineTool({
  name: "propose_shift_update",
  kind: "propose",
  permission: "scheduling.manage",
  description:
    "Draft a change to an existing shift's times or headcount for the manager " +
    "to confirm. NOTHING IS CHANGED by this tool.",
  schema: z.object({
    shiftId: z.string().uuid(),
    startTime: wallClock.optional().describe("new local start"),
    endTime: wallClock.optional().describe("new local end"),
    requiredCount: z.number().int().min(1).max(200).optional(),
  }),
  handler: async (input, ctx): Promise<ProposalToolResult> => {
    if (!input.startTime && !input.endTime && input.requiredCount === undefined) {
      return { status: "needs_input", missing: ["change"], hint: "What should change?" };
    }

    const { data: shift } = await ctx.auth.supabase
      .from("shifts")
      .select("id, date, start_time, end_time, required_count, status, jobs(client_name, locations(name))")
      .eq("company_id", ctx.companyId)
      .eq("id", input.shiftId)
      .maybeSingle();
    if (!shift) return { status: "refused", reason: "That shift does not exist here." };

    const row = shift as unknown as {
      id: string;
      date: string;
      start_time: string;
      end_time: string;
      required_count: number;
      status: string;
      jobs: { client_name: string; locations: { name: string } | null } | null;
    };
    if (row.status === "cancelled" || row.status === "completed") {
      return { status: "refused", reason: `That shift is ${row.status}.` };
    }

    // Both ends move together: update_shift refuses an inverted interval, and
    // sending only one end is the most common way to produce one.
    const nextStart = input.startTime
      ? operatingWallClockToUtc(row.date, input.startTime).toISOString()
      : row.start_time;
    const nextEnd = input.endTime
      ? operatingWallClockToUtc(row.date, input.endTime).toISOString()
      : row.end_time;
    if (new Date(nextEnd) <= new Date(nextStart)) {
      return { status: "refused", reason: "The end time would not be after the start." };
    }

    const summary: Array<{ field: string; from: string; to: string }> = [];
    if (nextStart !== row.start_time) {
      summary.push({ field: "start", from: row.start_time, to: nextStart });
    }
    if (nextEnd !== row.end_time) {
      summary.push({ field: "end", from: row.end_time, to: nextEnd });
    }
    if (input.requiredCount !== undefined && input.requiredCount !== row.required_count) {
      summary.push({
        field: "requiredCount",
        from: String(row.required_count),
        to: String(input.requiredCount),
      });
    }
    if (summary.length === 0) return { status: "refused", reason: "That is already the case." };

    const label = `${row.jobs?.locations?.name ?? row.jobs?.client_name ?? "shift"} · ${row.date}`;
    return proposed(
      {
        kind: "update_shift",
        shiftId: row.id,
        shiftLabel: label,
        changes: {
          ...(nextStart !== row.start_time ? { startTime: nextStart } : {}),
          ...(nextEnd !== row.end_time ? { endTime: nextEnd } : {}),
          ...(input.requiredCount !== undefined ? { requiredCount: input.requiredCount } : {}),
        },
        summary,
      },
      ctx,
      { shift: label, changes: summary }
    );
  },
});

/* ------------------------------------------------------------------ */
/* Supporting read used by the assignment flow                         */
/* ------------------------------------------------------------------ */

const listOfferResponses = defineTool({
  name: "list_offer_responses",
  kind: "read",
  permission: "scheduling.manage",
  description: "Who has answered the open offer on a shift, and how.",
  schema: z.object({ shiftId: z.string().uuid() }),
  handler: async (input, ctx) => {
    const { data } = await ctx.auth.supabase
      .from("shift_offer_responses")
      .select(
        "id, response, decided_at, employees(full_name), shift_offers!inner(shift_id, status)"
      )
      .eq("company_id", ctx.companyId)
      .eq("shift_offers.shift_id", input.shiftId)
      .limit(50);

    const rows = (data ?? []) as unknown as Array<{
      id: string;
      response: string;
      decided_at: string | null;
      employees: { full_name: string } | null;
      shift_offers: { status: string } | null;
    }>;

    return {
      count: rows.length,
      responses: rows.map((r) => ({
        responseId: r.id,
        name: r.employees?.full_name ?? "—",
        response: r.response,
        decided: r.decided_at !== null,
        offerStatus: r.shift_offers?.status ?? null,
      })),
    };
  },
});

/** Occupancy helper kept here so the assignment flow can report seats left. */
export const OCCUPYING_STATUSES = OCCUPYING_ASSIGNMENT_STATUSES;

export const PROPOSE_TOOLS: readonly AiTool[] = [
  listOfferResponses,
  proposeCreateShifts,
  proposeReplacementOffer,
  proposeAssignment,
  proposeShiftUpdate,
];
