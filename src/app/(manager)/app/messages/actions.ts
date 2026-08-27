"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireContext, requirePermission, AuthzError } from "@/lib/authz";
import { validatedAction, uuid } from "@/lib/validation";
import { OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/eligibility";

/**
 * Internal messaging — the smallest thing that is actually useful during a
 * replacement, and deliberately not a chat product.
 *
 * The schema already models this properly (`conversations`,
 * `conversation_participants`, `messages`) with participant-scoped RLS from
 * migration 0002, so these actions add no access rules of their own: they write
 * through the caller's client and the policies decide. In particular
 * `messages_insert` requires `app.is_participant(conversation_id)`, so posting
 * into somebody else's thread fails in the database, not here.
 *
 * `last_read_at` on the participant row is the unread model. It already exists
 * and is self-updatable (`participants_self_update`), so nothing new was needed.
 */

/** Values of the existing `conversation_topic` enum this feature uses. */
type ConversationTopic = "direct" | "schedule";

export type SendMessageOutcome =
  | { kind: "sent"; conversationId: string }
  | { kind: "refused"; reason: "not_participant" | "empty" };

const bodySchema = z.string().trim().min(1).max(4000);

/* ------------------------------------------------------------------ */
/* Post into an existing conversation                                  */
/* ------------------------------------------------------------------ */

export const sendMessage = validatedAction(
  z.object({ conversationId: uuid, body: bodySchema }),
  async (input): Promise<SendMessageOutcome> => {
    // Any active member may take part in a conversation they belong to —
    // employees included. Membership is the floor; RLS is the ceiling.
    const ctx = await requireContext();

    const { error } = await ctx.supabase.from("messages").insert({
      company_id: ctx.membership.company_id,
      conversation_id: input.conversationId,
      sender_id: ctx.userId,
      body: input.body,
    });
    // A non-participant is rejected by messages_insert rather than by code
    // here, and surfaces as an RLS violation.
    if (error) return { kind: "refused", reason: "not_participant" };

    // Touching the conversation keeps the inbox ordered by real activity.
    await ctx.supabase
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", input.conversationId);

    await markRead(ctx, input.conversationId);

    revalidatePath("/app/messages");
    revalidatePath("/me/messages");
    return { kind: "sent", conversationId: input.conversationId };
  }
);

/* ------------------------------------------------------------------ */
/* Start a direct conversation with one employee                       */
/* ------------------------------------------------------------------ */

export const startDirectConversation = validatedAction(
  z.object({ employeeId: uuid, body: bodySchema }),
  async (input): Promise<SendMessageOutcome> => {
    // Starting a thread with an employee is a staff action; an employee replies
    // to threads rather than opening one about somebody else.
    const ctx = await requirePermission("employees.read");
    const companyId = ctx.membership.company_id;

    const { data: employee } = await ctx.supabase
      .from("employees")
      .select("id, profile_id, full_name")
      .eq("company_id", companyId)
      .eq("id", input.employeeId)
      .maybeSingle();
    if (!employee) throw new AuthzError("wrong_tenant", "employee not accessible");
    if (!employee.profile_id) return { kind: "refused", reason: "not_participant" };

    const conversationId = await createConversation(ctx, {
      topic: "direct",
      subject: employee.full_name as string,
      participantProfileIds: [ctx.userId, employee.profile_id as string],
    });

    return sendInto(ctx, conversationId, input.body);
  }
);

/* ------------------------------------------------------------------ */
/* Message everybody working one shift                                 */
/* ------------------------------------------------------------------ */

/**
 * The reason this feature exists at all: during a replacement a dispatcher
 * needs to tell the crew on one shift something, once.
 *
 * Recipients are resolved from the assignment rows — never from the browser —
 * and only the statuses that still hold a seat are included, so somebody whose
 * cancellation was approved is not messaged about a shift they are off.
 */
export const messageShiftCrew = validatedAction(
  z.object({ shiftId: uuid, body: bodySchema }),
  async (input): Promise<SendMessageOutcome> => {
    const ctx = await requirePermission("scheduling.manage");
    const companyId = ctx.membership.company_id;

    const { data: shift } = await ctx.supabase
      .from("shifts")
      .select("id, date, jobs(client_name, locations(name))")
      .eq("company_id", companyId)
      .eq("id", input.shiftId)
      .maybeSingle();
    if (!shift) throw new AuthzError("wrong_tenant", "shift not accessible");

    const { data: assignments } = await ctx.supabase
      .from("shift_assignments")
      .select("employees(profile_id)")
      .eq("company_id", companyId)
      .eq("shift_id", input.shiftId)
      .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES])
      .limit(100);

    const profileIds = [
      ...new Set(
        ((assignments ?? []) as unknown as Array<{ employees: { profile_id: string | null } | null }>)
          .map((a) => a.employees?.profile_id)
          .filter((id): id is string => Boolean(id))
      ),
    ];
    if (profileIds.length === 0) return { kind: "refused", reason: "not_participant" };

    const row = shift as unknown as {
      date: string;
      jobs: { client_name: string; locations: { name: string } | null } | null;
    };
    const label = `${row.jobs?.locations?.name ?? row.jobs?.client_name ?? "Shift"} · ${row.date}`;

    const conversationId = await createConversation(ctx, {
      // 'schedule' rather than a new enum value: conversation_topic already
      // models this and adding to an enum would mean a migration.
      topic: "schedule",
      subject: label,
      participantProfileIds: [ctx.userId, ...profileIds],
    });

    return sendInto(ctx, conversationId, input.body);
  }
);

/* ------------------------------------------------------------------ */
/* Read state                                                          */
/* ------------------------------------------------------------------ */

export const markConversationRead = validatedAction(
  z.object({ conversationId: uuid }),
  async (input): Promise<{ kind: "ok" }> => {
    const ctx = await requireContext();
    await markRead(ctx, input.conversationId);
    revalidatePath("/app/messages");
    revalidatePath("/me/messages");
    return { kind: "ok" };
  }
);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type Ctx = Awaited<ReturnType<typeof requireContext>>;

async function createConversation(
  ctx: Ctx,
  input: { topic: ConversationTopic; subject: string; participantProfileIds: string[] }
): Promise<string> {
  const companyId = ctx.membership.company_id;

  const { data: conversation, error } = await ctx.supabase
    .from("conversations")
    .insert({
      company_id: companyId,
      topic: input.topic,
      subject: input.subject,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error || !conversation) throw new Error(`conversation: ${error?.message}`);

  const { error: participantError } = await ctx.supabase.from("conversation_participants").insert(
    [...new Set(input.participantProfileIds)].map((profileId) => ({
      company_id: companyId,
      conversation_id: conversation.id,
      profile_id: profileId,
      // The creator has by definition read what they just wrote.
      last_read_at: profileId === ctx.userId ? new Date().toISOString() : null,
    }))
  );
  if (participantError) throw new Error(`participants: ${participantError.message}`);

  return conversation.id as string;
}

async function sendInto(ctx: Ctx, conversationId: string, body: string): Promise<SendMessageOutcome> {
  const { error } = await ctx.supabase.from("messages").insert({
    company_id: ctx.membership.company_id,
    conversation_id: conversationId,
    sender_id: ctx.userId,
    body,
  });
  if (error) return { kind: "refused", reason: "not_participant" };

  revalidatePath("/app/messages");
  revalidatePath("/me/messages");
  return { kind: "sent", conversationId };
}

/** Own participant row only — `participants_self_update` enforces that. */
async function markRead(ctx: Ctx, conversationId: string): Promise<void> {
  await ctx.supabase
    .from("conversation_participants")
    .update({ last_read_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .eq("profile_id", ctx.userId);
}
