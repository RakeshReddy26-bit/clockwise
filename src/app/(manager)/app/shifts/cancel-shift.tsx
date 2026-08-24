"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cancelShift } from "./shift-actions";

/**
 * Call off a whole shift.
 *
 * Kept visually separate from the other actions on the planning card, and
 * behind a confirmation that restates what is about to happen to the people on
 * it. This is the only destructive action a dispatcher has that affects
 * several employees at once.
 */
export function CancelShift({
  shiftId,
  siteName,
  whenLabel,
  assignedCount,
}: {
  shiftId: string;
  siteName: string;
  whenLabel: string;
  assignedCount: number;
}) {
  const t = useTranslations("shiftForm");
  const tp = useTranslations("planning");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [settled, setSettled] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "error" } | null>(null);

  function submit(formData: FormData) {
    if (settled) return;
    setNotice(null);
    startTransition(async () => {
      const result = await cancelShift({
        shiftId,
        reason: String(formData.get("reason") ?? ""),
      });

      if (!result.ok) {
        setNotice({ text: tp("errorGeneric"), tone: "error" });
        return;
      }
      if (result.data.kind === "refused") {
        setNotice({ text: t(`refusedCancel_${result.data.status}`), tone: "error" });
        router.refresh();
        return;
      }

      setSettled(true);
      setConfirming(false);
      setNotice({
        text: t("cancelledNotice", { count: result.data.assignmentsCancelled }),
        tone: "success",
      });
      router.refresh();
    });
  }

  if (settled) {
    return notice ? (
      <p role="status" className="text-xs text-success">
        {notice.text}
      </p>
    ) : null;
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() => setConfirming(true)}
          disabled={isPending}
        >
          {t("cancelShift")}
        </Button>
        {notice && (
          <p role="alert" className="text-xs text-destructive">
            {notice.text}
          </p>
        )}
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-2 rounded-md border border-destructive/40 p-3">
      <p className="text-sm">
        {t("cancelConfirm", { site: siteName, when: whenLabel })}
      </p>
      {assignedCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("cancelConfirmPeople", { count: assignedCount })}
        </p>
      )}

      <Label htmlFor={`cancel-reason-${shiftId}`}>{t("cancelReasonLabel")}</Label>
      <textarea
        id={`cancel-reason-${shiftId}`}
        name="reason"
        rows={2}
        required
        minLength={5}
        maxLength={500}
        placeholder={t("cancelReasonHint")}
        className="rounded-md border border-input bg-card p-2 text-sm"
      />

      {notice && (
        <p role="alert" className="text-xs text-destructive">
          {notice.text}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={isPending}>
          {t("cancelShiftAction")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(false)}
          disabled={isPending}
        >
          {t("back")}
        </Button>
      </div>
    </form>
  );
}
