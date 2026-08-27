import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { ConversationView } from "@/components/conversation-view";
import { loadInbox, loadThread } from "@/lib/conversations";

/**
 * The employee inbox, on a phone.
 *
 * One column, not two: on a 390px screen a master-detail split gives neither
 * half enough room. Picking a thread replaces the list, and a back link returns
 * to it — the pattern every mobile mail client uses.
 *
 * An employee can reply but cannot start a thread. That is not a restriction
 * invented here; `startDirectConversation` requires `employees.read`, which the
 * EMPLOYEE role does not have.
 */
export const dynamic = "force-dynamic";

export default async function MyMessagesPage({
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

  if (selected) {
    const messages = await loadThread(ctx.supabase, selected.id, ctx.userId, locale);
    return (
      <div className="flex flex-col gap-3">
        <Link href="/me/messages" className="text-xs font-medium text-primary hover:underline">
          {t("backToInbox")}
        </Link>
        <ConversationView
          conversationId={selected.id}
          subject={selected.subject || t(`topic_${selected.topic}`)}
          messages={messages}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-xs text-muted-foreground">{t("employeeIntro")}</p>
      </div>

      {inbox.length === 0 ? (
        <EmptyState title={t("none")} body={t("noneEmployeeBody")} />
      ) : (
        <nav aria-label={t("title")} className="flex flex-col gap-2">
          {inbox.map((conversation) => (
            <Link
              key={conversation.id}
              href={`/me/messages?thread=${conversation.id}`}
              className="flex flex-col gap-0.5 rounded-lg border bg-card p-3 transition-colors hover:bg-secondary"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {conversation.subject || t(`topic_${conversation.topic}`)}
                </span>
                {conversation.unread && <Badge variant="warning">{t("unread")}</Badge>}
              </div>
              {conversation.lastMessage && (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {conversation.lastMessage}
                </span>
              )}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
