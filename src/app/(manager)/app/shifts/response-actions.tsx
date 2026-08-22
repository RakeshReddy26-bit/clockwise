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
export function ResponseActions({ responseId }: { responseId: string }) {
  const t = useTranslations("planning");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);

  function run(decision: "approve" | "reject") {
    setNotice(null);
    startTransition(async () => {
      const result =
        decision === "approve"
          ? await approveOfferResponse({ responseId })
          : await rejectOfferResponse({ responseId });

      if (!result.ok) {
        setNotice(t("errorGeneric"));
        return;
      }

      const outcome = result.data;
      if (outcome.kind === "approved" || outcome.kind === "rejected") {
        router.refresh();
        return;
      }
      if (outcome.kind === "ineligible") {
        setNotice(t(`refused_${outcome.reason}`));
        router.refresh();
        return;
      }
      setNotice(t(`refused_${outcome.status}`));
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1.5">
        <Button size="sm" onClick={() => run("approve")} disabled={isPending}>
          {t("approve")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => run("reject")} disabled={isPending}>
          {t("reject")}
        </Button>
      </div>
      {notice && <p className="max-w-56 text-right text-xs text-destructive">{notice}</p>}
    </div>
  );
}
