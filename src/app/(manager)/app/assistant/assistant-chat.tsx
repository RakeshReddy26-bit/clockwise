"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Send, Sparkles, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { askAssistant, confirmProposal, type AssistantHistory } from "./actions";

/**
 * The assistant conversation.
 *
 * The important behaviour here is what the Confirm button does NOT do: it does
 * not send a plan, it sends a token the server minted and signed. The card is a
 * rendering of that plan; the server re-derives everything from the token and
 * re-runs the real business logic. Editing the card in devtools changes what
 * this component draws and nothing else.
 */

type Proposal = { token: string; expiresAt: number; summary: unknown; kind: string };

type Entry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; proposals: Proposal[] }
  | { role: "system"; text: string; tone: "error" | "success" };

/** Opaque to this component — the server owns the transcript's shape. */
type History = AssistantHistory;

const SUGGESTIONS = ["needAttention", "whoToday", "understaffed", "createShifts"] as const;

export function AssistantChat() {
  const t = useTranslations("assistant");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<History>([]);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length, isPending]);

  function ask(message: string) {
    const text = message.trim();
    if (!text || isPending) return;
    setDraft("");
    setEntries((prev) => [...prev, { role: "user", text }]);

    startTransition(async () => {
      const result = await askAssistant({ message: text, history });
      if (!result.ok) {
        setEntries((prev) => [
          ...prev,
          { role: "system", text: t("errorGeneric"), tone: "error" },
        ]);
        return;
      }
      // Bound to a local so the narrowing survives into the setState callback.
      const outcome = result.data;
      if (outcome.kind === "unavailable") {
        setEntries((prev) => [
          ...prev,
          { role: "system", text: t(`unavailable_${outcome.code}`), tone: "error" },
        ]);
        return;
      }
      setHistory(outcome.history as History);
      setEntries((prev) => [
        ...prev,
        {
          role: "assistant",
          text: outcome.text || t("noAnswer"),
          proposals: outcome.proposals,
        },
      ]);
    });
  }

  function confirm(proposal: Proposal) {
    if (confirming) return;
    setConfirming(proposal.token);
    startTransition(async () => {
      const result = await confirmProposal({ token: proposal.token });
      setConfirming(null);

      if (!result.ok) {
        setEntries((prev) => [...prev, { role: "system", text: t("errorGeneric"), tone: "error" }]);
        return;
      }
      const outcome = result.data;
      const tone = outcome.status === "executed" ? "success" : "error";
      const text =
        outcome.status === "executed" || outcome.status === "partial"
          ? outcome.summary
          : outcome.reason;

      // The proposal is spent either way — a confirmed plan must not offer a
      // second Confirm button that would run it again.
      setEntries((prev) => [
        ...prev.map((entry) =>
          entry.role === "assistant"
            ? { ...entry, proposals: entry.proposals.filter((p) => p.token !== proposal.token) }
            : entry
        ),
        { role: "system", text, tone },
      ]);
      if (outcome.status === "executed" || outcome.status === "partial") router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Sparkles className="size-5 text-primary" />
          {t("title")}
        </h1>
        <p className="text-xs text-muted-foreground">{t("intro")}</p>
      </div>

      <div className="flex min-h-64 flex-col gap-3 rounded-lg border bg-card p-3">
        {entries.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="max-w-md text-sm text-muted-foreground">{t("emptyBody")}</p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => ask(t(`suggestion_${key}`))}
                  className="rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  {t(`suggestion_${key}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((entry, index) => (
          <div key={index}>
            {entry.role === "user" && (
              <p className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                {entry.text}
              </p>
            )}

            {entry.role === "assistant" && (
              <div className="flex max-w-[92%] flex-col gap-2">
                <p className="whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-sm">
                  {entry.text}
                </p>
                {entry.proposals.map((proposal) => (
                  <ProposalCard
                    key={proposal.token}
                    proposal={proposal}
                    busy={confirming === proposal.token || isPending}
                    onConfirm={() => confirm(proposal)}
                    onCancel={() =>
                      setEntries((prev) =>
                        prev.map((e, i) =>
                          i === index && e.role === "assistant"
                            ? {
                                ...e,
                                proposals: e.proposals.filter((p) => p.token !== proposal.token),
                              }
                            : e
                        )
                      )
                    }
                  />
                ))}
              </div>
            )}

            {entry.role === "system" && (
              <p
                role="status"
                className={`flex items-start gap-1.5 text-xs ${
                  entry.tone === "success" ? "text-success" : "text-destructive"
                }`}
              >
                {entry.tone === "success" ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                )}
                {entry.text}
              </p>
            )}
          </div>
        ))}

        {isPending && <p className="text-xs text-muted-foreground">{t("thinking")}</p>}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(draft);
        }}
        className="flex items-end gap-2"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline — the convention everywhere
            // else people type into a chat.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(draft);
            }
          }}
          rows={2}
          maxLength={2000}
          placeholder={t("placeholder")}
          aria-label={t("placeholder")}
          className="flex-1 resize-none rounded-md border border-input bg-card p-2 text-sm"
        />
        <Button type="submit" disabled={isPending || !draft.trim()} aria-label={t("send")}>
          <Send />
        </Button>
      </form>

      <p className="text-[11px] text-muted-foreground">{t("disclaimer")}</p>
    </div>
  );
}

/**
 * A plan awaiting a decision.
 *
 * The summary is rendered generically from whatever the proposal tool returned,
 * rather than switching on the kind. One card that grows a new row when a tool
 * gains a field beats four cards that drift apart.
 */
function ProposalCard({
  proposal,
  busy,
  onConfirm,
  onCancel,
}: {
  proposal: Proposal;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("assistant");
  const rows = Object.entries((proposal.summary ?? {}) as Record<string, unknown>).filter(
    ([, value]) => value !== null && value !== undefined && !isEmptyList(value)
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{t(`proposal_${proposal.kind}`)}</p>
        <Badge variant="warning">{t("notYetApplied")}</Badge>
      </div>

      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            {/* A tool may grow a summary field before a label exists for it;
                showing the raw key beats crashing the card. */}
            <dt className="text-muted-foreground">
              {t.has(`field_${key}`) ? t(`field_${key}`) : key}
            </dt>
            <dd className="tabular-nums">{renderValue(value)}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onConfirm} disabled={busy}>
          {t("confirm")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}

function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item !== null && typeof item === "object"
          ? Object.values(item as Record<string, unknown>).join(" ")
          : String(item)
      )
      .join(", ");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(", ");
  }
  return String(value);
}
