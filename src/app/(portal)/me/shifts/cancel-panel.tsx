"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requestShiftCancellation } from "./actions";

/**
 * Ask to be released from a shift.
 *
 * Nothing here decides anything: the reason is the only input, and every
 * refusal the server can return is turned into a sentence rather than a
 * generic failure. `sent` latches so a second submit cannot fire while the
 * page is still catching up.
 */
export function CancelPanel({
  assignmentId,
  hasPendingRequest,
}: {
  assignmentId: string;
  hasPendingRequest: boolean;
}) {
  const t = useTranslations("cancellation");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showForm, setShowForm] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (hasPendingRequest || sent) {
    return (
      <p role="status" className="text-xs text-warning">
        {t("pending")} <span className="text-muted-foreground">{t("stillAssigned")}</span>
      </p>
    );
  }

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await requestShiftCancellation({
        shiftAssignmentId: assignmentId,
        reason: String(formData.get("reason") ?? ""),
      });

      if (!result.ok) {
        setError(t("error"));
        return;
      }
      if (result.data.kind === "refused") {
        setError(t(`refused_${result.data.reason}`));
        router.refresh();
        return;
      }

      setSent(true);
      setShowForm(false);
      router.refresh();
    });
  }

  if (!showForm) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Button variant="ghost" size="sm" onClick={() => setShowForm(true)} disabled={isPending}>
          {t("request")}
        </Button>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-2 rounded-lg border p-3">
      <Label htmlFor="cancel-reason">{t("reasonLabel")}</Label>
      <textarea
        id="cancel-reason"
        name="reason"
        rows={3}
        required
        minLength={5}
        maxLength={500}
        placeholder={t("reasonHint")}
        className="rounded-md border border-input bg-card p-2 text-sm"
      />
      <p className="text-xs text-muted-foreground">{t("stillAssigned")}</p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {t("submit")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setShowForm(false)}
          disabled={isPending}
        >
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
