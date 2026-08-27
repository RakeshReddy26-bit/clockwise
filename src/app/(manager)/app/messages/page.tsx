import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { ConversationView } from "@/components/conversation-view";
import { loadInbox, loadThread } from "@/lib/conversations";

/**
 * The manager inbox.
 *
 * Master-detail via the query string rather than client state, so a thread is
 * linkable and survives a reload — a dispatcher pasting "the Ostseekai thread"
 * to a colleague is a real thing that happens.
 *
 * There is no access check in this file, deliberately. `conversations_select`
 * restricts the list to threads this profile participates in, and
 * `messages_select` does the same for the thread body. Adding a role gate here
 * would suggest the security lives in the page, which it does not.
 */
export const dynamic = "force-dynamic";

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  const ctx = await getShellContext();
  const t = await getTranslations("messages");
  const locale = await getLocale();
  const { thread: selectedId } = await searchParams;

  const inbox = await loadInbox(ctx.supabase, ctx.userId);
  const selected = selectedId ? inbox.find((c) => c.id === selectedId) ?? null : null;
  const messages = selected ? await loadThread(ctx.supabase, selected.id, ctx.userId, locale) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-xs text-muted-foreground">{t("managerIntro")}</p>
      </div>

      {inbox.length === 0 ? (
        <EmptyState title={t("none")} body={t("noneManagerBody")} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-[20rem_1fr]">
          <nav aria-label={t("title")} className="flex flex-col gap-1.5">
            {inbox.map((conversation) => (
              <Link
                key={conversation.id}
                href={`/app/messages?thread=${conversation.id}`}
                className={`flex flex-col gap-0.5 rounded-lg border p-2.5 transition-colors ${
                  conversation.id === selected?.id
                    ? "border-primary bg-accent/40"
                    : "bg-card hover:bg-secondary"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {conversation.subject || t(`topic_${conversation.topic}`)}
                  </span>
                  {conversation.unread && <Badge variant="warning">{t("unread")}</Badge>}
                </div>
                {conversation.lastMessage && (
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {conversation.lastMessage}
                  </span>
                )}
              </Link>
            ))}
          </nav>

          {selected ? (
            <ConversationView
              conversationId={selected.id}
              subject={selected.subject || t(`topic_${selected.topic}`)}
              messages={messages}
            />
          ) : (
            <EmptyState title={t("selectThread")} />
          )}
        </div>
      )}
    </div>
  );
}
