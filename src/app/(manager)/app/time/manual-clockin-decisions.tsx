"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { decideManualClockIn } from "./actions";

type Notice = { text: string; tone: "success" | "error" } | null;

/**
 * Approve / reject one manual clock-in request.
 *
 * This replaces two bare <form action={…}> bindings whose wrappers threw the
 * action result away. validatedAction() converts an AuthzError into
 * { ok: false }, so nothing reached the manager: a refusal and a success looked
 * identical — a click, a revalidate, and no visible change.
 *
 * The refusal message stays generic on purpose. AuthzError('forbidden') covers
 * both "you lack time.manage" and "a colleague already decided this", and the
 * two are not distinguishable from here. Rather than guess, the list is
 * refreshed: a request that someone else settled disappears, which explains
 * itself better than any sentence would.
 */
export function ManualClockInDecision({
  requestId,
  employeeName,
}: {
  requestId: string;
  employeeName: string;
}) {
  const t = useTranslations("timeBoard");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [settled, setSettled] = useState(false);

  function run(decision: "approved" | "rejected") {
    if (settled) return;
    setNotice(null);
    startTransition(async () => {
      const result = await decideManualClockIn({ requestId, decision });

      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        router.refresh();
        return;
      }

      // Only reached when the server actually wrote the decision.
      setSettled(true);
      setNotice({
        text: t(
          result.data.outcome === "approved" ? "requestApproved" : "requestRejected",
          { name: employeeName }
        ),
        tone: "success",
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {!settled && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => run("approved")} disabled={isPending}>
            {t("approve")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => run("rejected")}
            disabled={isPending}
          >
            {t("reject")}
          </Button>
        </div>
      )}

      {notice && (
        <p
          role="status"
          className={`max-w-72 text-right text-xs ${
            notice.tone === "success" ? "text-success" : "text-destructive"
          }`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
