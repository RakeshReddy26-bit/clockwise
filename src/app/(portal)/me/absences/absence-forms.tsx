"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestVacation, reportSickLeave, withdrawVacation } from "./actions";

type Notice = { text: string; tone: "success" | "error" } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      role="status"
      className={`text-xs ${notice.tone === "success" ? "text-success" : "text-destructive"}`}
    >
      {notice.text}
    </p>
  );
}

/** Today, in the browser's own calendar — only ever a default and a `min`. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function VacationForm() {
  const t = useTranslations("absences");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");

  function submit() {
    setNotice(null);
    startTransition(async () => {
      const result = await requestVacation({
        startDate: start,
        endDate: end || start,
        note: note.trim() || undefined,
      });
      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }
      if (result.data.kind === "refused") {
        setNotice({ text: t(`refused_${result.data.reason}`), tone: "error" });
        return;
      }
      setNotice({ text: t("vacationSubmitted", { days: result.data.days }), tone: "success" });
      setStart("");
      setEnd("");
      setNote("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
      <div>
        <h2 className="text-sm font-semibold">{t("requestVacation")}</h2>
        <p className="text-xs text-muted-foreground">{t("requestVacationHint")}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="vac-start" className="text-xs">
            {t("from")}
          </Label>
          <Input
            id="vac-start"
            type="date"
            min={today()}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="vac-end" className="text-xs">
            {t("to")}
          </Label>
          <Input
            id="vac-end"
            type="date"
            min={start || today()}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="vac-note" className="text-xs">
          {t("noteOptional")}
        </Label>
        <Input
          id="vac-note"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <NoticeLine notice={notice} />
        <Button size="sm" onClick={submit} disabled={isPending || !start}>
          {t("submit")}
        </Button>
      </div>
    </div>
  );
}

export function SickForm() {
  const t = useTranslations("absences");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState("");
  const [comment, setComment] = useState("");

  function submit() {
    setNotice(null);
    startTransition(async () => {
      const result = await reportSickLeave({
        startDate: start,
        expectedEndDate: end || undefined,
        comment: comment.trim() || undefined,
      });
      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }
      // Reporting always succeeds. If it collided with a shift, the employee is
      // told their manager knows — not asked to sort it out themselves.
      setNotice({
        text:
          result.data.conflicts > 0
            ? t("sickReportedWithConflicts", { count: result.data.conflicts })
            : t("sickReported"),
        tone: "success",
      });
      setComment("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
      <div>
        <h2 className="text-sm font-semibold">{t("reportSick")}</h2>
        <p className="text-xs text-muted-foreground">{t("reportSickHint")}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="sick-start" className="text-xs">
            {t("since")}
          </Label>
          <Input
            id="sick-start"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="sick-end" className="text-xs">
            {t("expectedUntil")}
          </Label>
          <Input
            id="sick-end"
            type="date"
            min={start}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="sick-comment" className="text-xs">
          {t("noteOptional")}
        </Label>
        <Input
          id="sick-comment"
          value={comment}
          maxLength={500}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <NoticeLine notice={notice} />
        <Button size="sm" variant="outline" onClick={submit} disabled={isPending || !start}>
          {t("report")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Withdraw one pending request. `settled` latches so a second click cannot fire
 * while the page catches up — the same shape as the cancellation actions.
 */
export function WithdrawButton({ requestId }: { requestId: string }) {
  const t = useTranslations("absences");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [settled, setSettled] = useState(false);

  function run() {
    if (settled) return;
    setNotice(null);
    startTransition(async () => {
      const result = await withdrawVacation({ requestId });
      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }
      if (result.data.kind === "refused") {
        setNotice({ text: t("refused_not_pending"), tone: "error" });
        router.refresh();
        return;
      }
      setSettled(true);
      setNotice({ text: t("withdrawn"), tone: "success" });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {!settled && (
        <Button size="sm" variant="outline" onClick={run} disabled={isPending}>
          {t("withdraw")}
        </Button>
      )}
      <NoticeLine notice={notice} />
    </div>
  );
}
