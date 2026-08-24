"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  decideVacationRequest,
  decideSickLeave,
  type ConflictingAssignment,
} from "./actions";

type Notice = { text: string; tone: "success" | "error" } | null;

/**
 * Approve / reject one vacation request.
 *
 * The interesting state is the third one. When the employee still holds a shift
 * inside the requested period the server refuses and returns the conflicts, so
 * this component stops being a pair of buttons and becomes an explanation of
 * what has to happen first — with a link to the shift, because the fix lives
 * there and not here.
 */
export function VacationDecision({
  requestId,
  employeeName,
}: {
  requestId: string;
  employeeName: string;
}) {
  const t = useTranslations("absences");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [conflicts, setConflicts] = useState<ConflictingAssignment[] | null>(null);
  const [settled, setSettled] = useState(false);

  function run(approve: boolean) {
    if (settled) return;
    setNotice(null);
    startTransition(async () => {
      const result = await decideVacationRequest({ requestId, approve });
      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }
      const outcome = result.data;

      if (outcome.kind === "conflicts") {
        // Nothing was written. Saying so matters: the manager must not think
        // half the decision landed.
        setConflicts(outcome.conflicts);
        setNotice({
          text: t("conflictRefusal", {
            name: outcome.employeeName || employeeName,
            count: outcome.conflicts.length,
          }),
          tone: "error",
        });
        return;
      }

      if (outcome.kind === "decided") {
        setSettled(true);
        setConflicts(null);
        setNotice({
          text: t(outcome.status === "approved" ? "vacationApproved" : "vacationRejected", {
            name: outcome.employeeName || employeeName,
          }),
          tone: "success",
        });
        router.refresh();
        return;
      }

      setNotice({ text: t(`refusedVacation_${outcome.status}`), tone: "error" });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {!settled && (
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => run(true)} disabled={isPending}>
            {t("approve")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => run(false)} disabled={isPending}>
            {t("reject")}
          </Button>
        </div>
      )}

      {notice && (
        <p
          role="status"
          className={`max-w-80 text-right text-xs ${
            notice.tone === "success" ? "text-success" : "text-destructive"
          }`}
        >
          {notice.text}
        </p>
      )}

      {conflicts && conflicts.length > 0 && (
        <ul className="flex flex-col items-end gap-0.5">
          {conflicts.map((c) => (
            <li key={c.assignment_id} className="text-[11px] text-muted-foreground tabular-nums">
              <a className="underline underline-offset-2" href={`/app/shifts?shift=${c.shift_id}`}>
                {c.date}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Confirm that a certificate arrived, or close the leave. Never a rejection. */
export function SickDecision({
  sickLeaveId,
  status,
  employeeName,
}: {
  sickLeaveId: string;
  status: string;
  employeeName: string;
}) {
  const t = useTranslations("absences");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [settled, setSettled] = useState(false);

  function run(next: "confirmed" | "closed") {
    if (settled) return;
    setNotice(null);
    startTransition(async () => {
      const result = await decideSickLeave({ sickLeaveId, status: next });
      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }
      const outcome = result.data;
      if (outcome.kind === "decided") {
        setSettled(true);
        setNotice({
          text: t(outcome.status === "confirmed" ? "sickConfirmed" : "sickClosed", {
            name: outcome.employeeName || employeeName,
          }),
          tone: "success",
        });
        router.refresh();
        return;
      }
      setNotice({ text: t(`refusedSick_${outcome.status}`), tone: "error" });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {!settled && (
        <div className="flex gap-1.5">
          {status === "reported" && (
            <Button size="sm" onClick={() => run("confirmed")} disabled={isPending}>
              {t("confirm")}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => run("closed")} disabled={isPending}>
            {t("close")}
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
