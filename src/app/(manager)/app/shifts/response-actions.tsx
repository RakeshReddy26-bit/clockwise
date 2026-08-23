"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { approveOfferResponse, rejectOfferResponse } from "./actions";

/**
 * Approve / Reject for one interested response. Deliberately thin: every
 * decision is made on the server, and this only turns a refusal code into a
 * sentence the manager can act on.
 */
export function ResponseActions({
  responseId,
  employeeName,
}: {
  responseId: string;
  employeeName: string;
}) {
  const t = useTranslations("planning");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  /**
   * A decision is final, and the row it belongs to only stops rendering these
   * buttons after the refresh lands. Latching here closes that window so a
   * second click cannot fire while the page is catching up.
   */
  const [settled, setSettled] = useState(false);

  function run(decision: "approve" | "reject") {
    if (settled) return;
    setNotice(null);
    startTransition(async () => {
      const result =
        decision === "approve"
          ? await approveOfferResponse({ responseId })
          : await rejectOfferResponse({ responseId });

      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }

      const outcome = result.data;
      if (outcome.kind === "approved") {
        setSettled(true);
        setNotice({
          text: outcome.shiftFilled
            ? t("approvedAndFilled", { name: employeeName })
            : t("approvedSuccess", { name: employeeName }),
          tone: "success",
        });
        router.refresh();
        return;
      }
      if (outcome.kind === "rejected") {
        setSettled(true);
        setNotice({ text: t("rejectedSuccess", { name: employeeName }), tone: "success" });
        router.refresh();
        return;
      }
      if (outcome.kind === "ineligible") {
        setNotice({ text: t(`refused_${outcome.reason}`), tone: "error" });
        router.refresh();
        return;
      }
      setNotice({ text: t(`refused_${outcome.status}`), tone: "error" });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {!settled && (
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => run("approve")} disabled={isPending}>
            {t("approve")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => run("reject")} disabled={isPending}>
            {t("reject")}
          </Button>
        </div>
      )}
      {notice && (
        <p
          role="status"
          className={`max-w-64 text-right text-xs ${
            notice.tone === "success" ? "text-success" : "text-destructive"
          }`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
