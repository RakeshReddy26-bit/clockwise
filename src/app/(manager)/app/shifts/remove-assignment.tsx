"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { removeShiftAssignment } from "./actions";

/**
 * Take one employee off a shift.
 *
 * Two deliberate frictions: the action is contextual rather than a permanent
 * button on every row, and it opens a confirmation that restates who is being
 * removed from what before a reason can be submitted. Removing the wrong
 * person from a live shift is expensive in a way an extra click is not.
 */
export function RemoveAssignment({
  assignmentId,
  employeeName,
  siteName,
  whenLabel,
}: {
  assignmentId: string;
  employeeName: string;
  siteName: string;
  whenLabel: string;
}) {
  const t = useTranslations("planning");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [settled, setSettled] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "error" } | null>(null);

  function submit(formData: FormData) {
    if (settled) return;
    setNotice(null);
    startTransition(async () => {
      const result = await removeShiftAssignment({
        assignmentId,
        reason: String(formData.get("reason") ?? ""),
      });

      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }

      if (result.data.kind === "refused") {
        setNotice({ text: t(`refusedRemoval_${result.data.status}`), tone: "error" });
        router.refresh();
        return;
      }

      const { employeeName: name, seatsOpen, shiftStatus } = result.data;
      setSettled(true);
      setConfirming(false);
      setNotice({
        text:
          shiftStatus === "staffed" || seatsOpen === 0
            ? t("removedStillStaffed", { name: name || employeeName })
            : t("removedVacancy", { name: name || employeeName, count: seatsOpen }),
        tone: "success",
      });
      router.refresh();
    });
  }

  if (settled) {
    return notice ? (
      <p role="status" className="max-w-72 text-right text-xs text-success">
        {notice.text}
      </p>
    ) : null;
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(true)}
          disabled={isPending}
        >
          {t("removeFromShift")}
        </Button>
        {notice && (
          <p role="alert" className="max-w-72 text-right text-xs text-destructive">
            {notice.text}
          </p>
        )}
      </div>
    );
  }

  return (
    <form action={submit} className="flex w-full flex-col gap-2 rounded-md border p-3">
      <p className="text-sm">
        {t.rich("removeConfirm", {
          name: employeeName,
          site: siteName,
          when: whenLabel,
          strong: (chunks) => <span className="font-medium">{chunks}</span>,
        })}
      </p>

      <Label htmlFor={`remove-reason-${assignmentId}`}>{t("removeReasonLabel")}</Label>
      <textarea
        id={`remove-reason-${assignmentId}`}
        name="reason"
        rows={2}
        required
        minLength={5}
        maxLength={500}
        placeholder={t("removeReasonHint")}
        className="rounded-md border border-input bg-card p-2 text-sm"
      />
      <p className="text-xs text-muted-foreground">{t("removeReasonPrivacy")}</p>

      {notice && (
        <p role="alert" className="text-xs text-destructive">
          {notice.text}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={isPending}>
          {t("removeConfirmAction")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(false)}
          disabled={isPending}
        >
          {t("cancelAction")}
        </Button>
      </div>
    </form>
  );
}
