"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sendMessage } from "@/app/(manager)/app/messages/actions";

/**
 * One conversation thread, used by both shells.
 *
 * Deliberately plain: no realtime, no typing indicators, no reactions. This
 * exists so a dispatcher and a worker can settle a replacement without leaving
 * Clockwise, and anything beyond that is a different product.
 *
 * The action is shared with the manager side on purpose — `sendMessage` only
 * requires membership, and `messages_insert` decides whether this particular
 * person may post into this particular thread.
 */

export type ThreadMessage = {
  id: string;
  body: string;
  sentAt: string;
  senderName: string;
  fromMe: boolean;
};

export function ConversationView({
  conversationId,
  subject,
  messages,
  canReply = true,
}: {
  conversationId: string;
  subject: string;
  messages: ThreadMessage[];
  canReply?: boolean;
}) {
  const t = useTranslations("messages");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const body = draft.trim();
    if (!body || isPending) return;
    setError(null);

    startTransition(async () => {
      const result = await sendMessage({ conversationId, body });
      if (!result.ok || result.data.kind === "refused") {
        setError(t("sendFailed"));
        return;
      }
      setDraft("");
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
      <h2 className="text-sm font-semibold">{subject}</h2>

      {messages.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noMessages")}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {messages.map((message) => (
            <li
              key={message.id}
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                message.fromMe
                  ? "ml-auto bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground"
              }`}
            >
              {!message.fromMe && (
                <p className="text-[11px] font-medium opacity-80">{message.senderName}</p>
              )}
              <p className="whitespace-pre-wrap">{message.body}</p>
              <p className="mt-0.5 text-[10px] tabular-nums opacity-70">{message.sentAt}</p>
            </li>
          ))}
        </ol>
      )}

      {canReply && (
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            maxLength={4000}
            placeholder={t("replyPlaceholder")}
            aria-label={t("replyPlaceholder")}
            className="flex-1 resize-none rounded-md border border-input bg-background p-2 text-sm"
          />
          <Button onClick={submit} disabled={isPending || !draft.trim()} aria-label={t("send")}>
            <Send />
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
