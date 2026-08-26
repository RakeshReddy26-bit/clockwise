import "server-only";

import { requirePermission } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { verifyProposal, type ProposalPayload } from "@/lib/ai/proposals";
import { createShift, updateShift } from "@/app/(manager)/app/shifts/shift-actions";
import { sendShiftOffer, approveOfferResponse } from "@/app/(manager)/app/shifts/actions";

/**
 * The confirmation boundary. Every write the assistant can cause passes here,
 * and only here.
 *
 * What this file does NOT contain is the interesting part: no SQL, no
 * eligibility rule, no capacity arithmetic, no permission logic of its own. It
 * verifies that a human confirmed this exact plan, then calls the same Server
 * Actions the manual UI calls. Those actions re-authorize, re-validate and
 * re-run eligibility against fresh rows, and the SQL functions behind them
 * re-check once more under a row lock.
 *
 * So a confirmed proposal is a REQUEST to run existing business logic, not a
 * licence to bypass it. If the world changed between proposal and confirmation
 * — someone took the last seat, the employee went sick — the underlying action
 * refuses exactly as it would have for a manager clicking the button.
 */

export type ExecutionOutcome =
  | { status: "executed"; summary: string; ids: string[] }
  | { status: "partial"; summary: string; ids: string[]; failures: string[] }
  | { status: "refused"; reason: string }
  | { status: "invalid"; reason: string };

/**
 * Run a proposal the user just confirmed.
 *
 * `token` is what the browser sends back; the identity it is checked against
 * comes from the session, so a token minted for another user or tenant is
 * rejected before anything else happens.
 */
export async function executeConfirmedProposal(token: string): Promise<ExecutionOutcome> {
  // Permission first, from the session. Everything the assistant can execute
  // is scheduling work, so this is the single gate — and it is the same
  // permission the manual pages require.
  const ctx = await requirePermission("scheduling.manage");

  const verified = verifyProposal(token, {
    userId: ctx.userId,
    companyId: ctx.membership.company_id,
  });
  if (!verified.ok) {
    // Deliberately vague to the user, specific in the log: a forged token
    // should not learn which check it failed.
    console.warn(`ai proposal rejected: ${verified.reason} (user ${ctx.userId})`);
    return {
      status: "invalid",
      reason:
        verified.reason === "expired"
          ? "That plan has expired. Ask again and confirm the new one."
          : "That plan could not be verified. Please ask again.",
    };
  }

  const payload = verified.envelope.payload;

  await writeAudit(ctx, {
    action: `ai.${payload.kind}.confirmed`,
    entity: "ai_proposal",
    diff: auditDiff(payload),
  });

  const outcome = await dispatch(payload);

  await writeAudit(ctx, {
    action: `ai.${payload.kind}.${outcome.status}`,
    entity: "ai_proposal",
    diff: { status: outcome.status, ids: "ids" in outcome ? outcome.ids : [] },
  });

  return outcome;
}

async function dispatch(payload: ProposalPayload): Promise<ExecutionOutcome> {
  switch (payload.kind) {
    case "create_shifts":
      return executeCreateShifts(payload);
    case "send_offer":
      return executeSendOffer(payload);
    case "approve_response":
      return executeApproveResponse(payload);
    case "update_shift":
      return executeUpdateShift(payload);
  }
}

/**
 * Create every shift in the plan.
 *
 * `create_shift` is one RPC per shift and there is no multi-shift RPC to reuse,
 * so a batch is not atomic. Rather than invent a transaction boundary that the
 * tested code does not have, this stops at the first refusal and reports
 * exactly what was and was not created. A manager who is told "2 of 4 created,
 * here they are" can finish the job; one who is told "something went wrong"
 * cannot. Creating shifts is additive and individually visible in the planner,
 * so a partial batch is inspectable rather than corrupting.
 */
async function executeCreateShifts(
  payload: Extract<ProposalPayload, { kind: "create_shifts" }>
): Promise<ExecutionOutcome> {
  const created: string[] = [];
  const failures: string[] = [];

  for (const [index, shift] of payload.shifts.entries()) {
    const result = await createShift({
      jobId: shift.jobId,
      startTime: shift.startTime,
      endTime: shift.endTime,
      requiredCount: shift.requiredCount,
      requiredRole: shift.requiredRole ?? undefined,
      requiredQualification: shift.requiredQualification ?? undefined,
    });

    if (!result.ok) {
      failures.push(`shift ${index + 1} (${shift.date}): could not be created`);
      break;
    }
    if (result.data.kind === "refused") {
      failures.push(`shift ${index + 1} (${shift.date}): ${result.data.status}`);
      break;
    }
    created.push(result.data.shiftId);
  }

  if (failures.length === 0) {
    return {
      status: "executed",
      summary: `Created ${created.length} shift${created.length === 1 ? "" : "s"} at ${payload.shifts[0].siteLabel}.`,
      ids: created,
    };
  }
  if (created.length === 0) {
    return { status: "refused", reason: failures[0] };
  }
  return {
    status: "partial",
    summary: `Created ${created.length} of ${payload.shifts.length} shifts before stopping.`,
    ids: created,
    failures,
  };
}

async function executeSendOffer(
  payload: Extract<ProposalPayload, { kind: "send_offer" }>
): Promise<ExecutionOutcome> {
  const result = await sendShiftOffer({
    shiftId: payload.shiftId,
    employeeIds: payload.employees.map((e) => e.employeeId),
    ...(payload.message ? { message: payload.message } : {}),
  });

  if (!result.ok) return { status: "refused", reason: "The offer could not be sent." };

  const outcome = result.data;
  switch (outcome.kind) {
    case "sent":
      return {
        status: "executed",
        summary: `Offer sent to ${outcome.invited} employee${outcome.invited === 1 ? "" : "s"} for ${payload.shiftLabel}.`,
        ids: [outcome.offerId],
      };
    case "shift_not_open":
      return { status: "refused", reason: "That shift is no longer open." };
    case "shift_fully_staffed":
      return { status: "refused", reason: "That shift has since been fully staffed." };
    case "shift_in_past":
      return { status: "refused", reason: "That shift has already started." };
    case "no_eligible_selection":
      return {
        status: "refused",
        reason: "None of those people are still available for that shift.",
      };
  }
}

async function executeApproveResponse(
  payload: Extract<ProposalPayload, { kind: "approve_response" }>
): Promise<ExecutionOutcome> {
  const result = await approveOfferResponse({ responseId: payload.responseId });
  if (!result.ok) return { status: "refused", reason: "The assignment could not be made." };

  const outcome = result.data;
  if (outcome.kind === "approved") {
    return {
      status: "executed",
      summary: `${payload.employeeName} is assigned to ${payload.shiftLabel}.`,
      ids: [outcome.assignmentId],
    };
  }
  if (outcome.kind === "ineligible") {
    return {
      status: "refused",
      reason: `${payload.employeeName} can no longer work that shift (${outcome.reason}).`,
    };
  }
  return { status: "refused", reason: `Refused: ${outcome.status}.` };
}

async function executeUpdateShift(
  payload: Extract<ProposalPayload, { kind: "update_shift" }>
): Promise<ExecutionOutcome> {
  // `confirm: true` is the SHIFT-LEVEL confirmation that an edit may close an
  // open offer — a different thing from the manager confirming this proposal.
  // Passing it is correct here precisely because a human already saw the plan.
  const result = await updateShift({
    shiftId: payload.shiftId,
    confirm: true,
    patch: {
      ...(payload.changes.startTime ? { startTime: payload.changes.startTime } : {}),
      ...(payload.changes.endTime ? { endTime: payload.changes.endTime } : {}),
      ...(payload.changes.requiredCount !== undefined
        ? { requiredCount: payload.changes.requiredCount }
        : {}),
    },
  });

  if (!result.ok) return { status: "refused", reason: "The shift could not be updated." };

  const outcome = result.data;
  if (outcome.kind === "updated") {
    return { status: "executed", summary: `${payload.shiftLabel} updated.`, ids: [payload.shiftId] };
  }
  if (outcome.kind === "unchanged") {
    return { status: "refused", reason: "Nothing was different, so nothing changed." };
  }
  if (outcome.kind === "confirm") {
    return { status: "refused", reason: "That change needs to be made from the shift planner." };
  }
  return { status: "refused", reason: `Refused: ${outcome.status}.` };
}

/** What goes in the audit trail. Plans and ids only — never a transcript. */
function auditDiff(payload: ProposalPayload): Record<string, unknown> {
  switch (payload.kind) {
    case "create_shifts":
      return {
        kind: payload.kind,
        count: payload.shifts.length,
        jobId: payload.shifts[0]?.jobId ?? null,
        dates: payload.shifts.map((s) => s.date),
      };
    case "send_offer":
      return {
        kind: payload.kind,
        shiftId: payload.shiftId,
        employeeIds: payload.employees.map((e) => e.employeeId),
      };
    case "approve_response":
      return { kind: payload.kind, responseId: payload.responseId };
    case "update_shift":
      return { kind: payload.kind, shiftId: payload.shiftId, changes: payload.changes };
  }
}
