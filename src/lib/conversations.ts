import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ThreadMessage } from "@/components/conversation-view";

/**
 * Loading conversations, once, for both shells.
 *
 * The manager inbox and the employee inbox differ only in styling — the query
 * is identical, because `conversations_select` already restricts it to threads
 * the caller participates in. Writing it twice would mean two chances to forget
 * that and add a broader filter.
 */

export type InboxThread = {
  id: string;
  subject: string;
  topic: string;
  updatedAt: string;
  lastMessage: string | null;
  unread: boolean;
};

type ConversationRow = {
  id: string;
  subject: string | null;
  topic: string;
  updated_at: string;
};

/**
 * Threads this person belongs to, most recently active first.
 *
 * No `company_id` filter is needed and none is added: participation is already
 * per-conversation, and a participant row cannot span tenants because both
 * carry the same company.
 */
export async function loadInbox(
  supabase: SupabaseClient,
  profileId: string,
  limit = 25
): Promise<InboxThread[]> {
  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, subject, topic, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  const rows = (conversations ?? []) as unknown as ConversationRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [{ data: participants }, { data: latest }] = await Promise.all([
    supabase
      .from("conversation_participants")
      .select("conversation_id, last_read_at")
      .eq("profile_id", profileId)
      .in("conversation_id", ids)
      .limit(limit),
    supabase
      .from("messages")
      .select("conversation_id, body, sent_at")
      .in("conversation_id", ids)
      .order("sent_at", { ascending: false })
      .limit(limit * 8),
  ]);

  const readAt = new Map(
    ((participants ?? []) as Array<{ conversation_id: string; last_read_at: string | null }>).map(
      (p) => [p.conversation_id, p.last_read_at]
    )
  );

  // The newest message per thread, from one ordered fetch rather than N queries.
  const newest = new Map<string, { body: string; sent_at: string }>();
  for (const message of (latest ?? []) as Array<{
    conversation_id: string;
    body: string;
    sent_at: string;
  }>) {
    if (!newest.has(message.conversation_id)) {
      newest.set(message.conversation_id, { body: message.body, sent_at: message.sent_at });
    }
  }

  return rows.map((row) => {
    const last = newest.get(row.id) ?? null;
    const seenAt = readAt.get(row.id) ?? null;
    return {
      id: row.id,
      subject: row.subject ?? "",
      topic: row.topic,
      updatedAt: row.updated_at,
      lastMessage: last?.body ?? null,
      // Never read, or a message arrived after the last read.
      unread: Boolean(last) && (seenAt === null || last!.sent_at > seenAt),
    };
  });
}

/** Every message in one thread, oldest first, shaped for the view. */
export async function loadThread(
  supabase: SupabaseClient,
  conversationId: string,
  viewerProfileId: string,
  locale: string,
  limit = 100
): Promise<ThreadMessage[]> {
  const { data } = await supabase
    .from("messages")
    .select("id, body, sent_at, sender_id, profiles(full_name)")
    .eq("conversation_id", conversationId)
    .order("sent_at", { ascending: true })
    .limit(limit);

  return ((data ?? []) as unknown as Array<{
    id: string;
    body: string;
    sent_at: string;
    sender_id: string | null;
    profiles: { full_name: string } | null;
  }>).map((message) => ({
    id: message.id,
    body: message.body,
    sentAt: new Date(message.sent_at).toLocaleString(locale, {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }),
    senderName: message.profiles?.full_name ?? "—",
    fromMe: message.sender_id === viewerProfileId,
  }));
}
