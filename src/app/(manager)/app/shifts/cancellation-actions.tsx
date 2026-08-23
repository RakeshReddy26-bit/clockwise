"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { decideCancellationRequest } from "./actions";

/**
 * Approve / Reject for one cancellation request. Same shape as the offer
 * response actions: every decision is made on the server, this only turns a
 * refusal code into a sentence, and `settled` latches so a second click cannot
 * fire while the page is catching up.
 */
export function CancellationActions({
  requestId,
  employeeName,
}: {
  requestId: string;
  employeeName: string;
}) {
  const t = useTranslations("planning");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const [settled, setSettled] = useState(false);

  function run(approve: boolean) {
    if (settled) return;
    setNotice(null);
    startTransition(async () => {
      const result = await decideCancellationRequest({ requestId, approve });

      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }

      const outcome = result.data;
      if (outcome.kind === "approved") {
        setSettled(true);
        setNotice({
          text: t("cancellationApproved", {
            name: outcome.employeeName || employeeName,
            count: outcome.seatsOpen,
          }),
          tone: "success",
        });
        router.refresh();
        return;
      }
      if (outcome.kind === "rejected") {
        setSettled(true);
        setNotice({
          text: t("cancellationRejected", { name: outcome.employeeName || employeeName }),
          tone: "success",
        });
        router.refresh();
        return;
      }

      setNotice({ text: t(`refusedCancellation_${outcome.status}`), tone: "error" });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {!settled && (
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => run(true)} disabled={isPending}>
            {t("approveCancellation")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => run(false)} disabled={isPending}>
            {t("rejectCancellation")}
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
