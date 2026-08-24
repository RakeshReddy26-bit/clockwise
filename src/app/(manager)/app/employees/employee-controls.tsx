"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMPLOYMENT_STATUSES, type AssignmentConflict } from "@/lib/employee";
import { changeEmploymentStatus, saveQualification, removeQualification } from "./actions";

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

/**
 * The conflicting future shifts an action reported.
 *
 * Shown as work for a person, never as an error: the record changed, and these
 * are the shifts somebody now has to re-staff. Each links to the planning board,
 * because that is where the C.1 removal lives — this page deliberately cannot
 * release anyone.
 */
function ConflictList({ conflicts, label }: { conflicts: AssignmentConflict[]; label: string }) {
  if (conflicts.length === 0) return null;
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
      <p className="text-xs font-medium text-destructive">{label}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {conflicts.map((conflict) => (
          <li key={conflict.assignment_id} className="text-[11px] tabular-nums">
            <a
              className="underline underline-offset-2"
              href={`/app/shifts?shift=${conflict.shift_id}`}
            >
              {conflict.date}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Change employment status.
 *
 * The status always commits — employment is a fact, not a request — and any
 * future shifts the person still holds come back as a list. Nothing is cancelled
 * here. That asymmetry with vacation approval (which refuses on conflict) is
 * deliberate and is explained in migration 0016.
 */
export function StatusControl({
  employeeId,
  current,
  hasAccount,
}: {
  employeeId: string;
  current: string;
  hasAccount: boolean;
}) {
  const t = useTranslations("employees");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [conflicts, setConflicts] = useState<AssignmentConflict[]>([]);
  const [target, setTarget] = useState(current);

  function submit() {
    setNotice(null);
    setConflicts([]);
    startTransition(async () => {
      const result = await changeEmploymentStatus({
        employeeId,
        status: target as (typeof EMPLOYMENT_STATUSES)[number],
      });
      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }
      if (result.data.kind === "refused") {
        setNotice({ text: t(`refusedStatus_${result.data.reason}`), tone: "error" });
        return;
      }
      setConflicts(result.data.conflicts);
      setNotice({
        text:
          result.data.conflicts.length > 0
            ? t("statusChangedWithConflicts", {
                status: t(`status_${result.data.to}`),
                count: result.data.conflicts.length,
              })
            : t("statusChanged", { status: t(`status_${result.data.to}`) }),
        tone: "success",
      });
      router.refresh();
    });
  }

  const leaving = target !== current && !["active", "probation"].includes(target);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="employment_status" className="text-xs">
            {t("fieldStatus")}
          </Label>
          <select
            id="employment_status"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-9 rounded-md border border-input bg-card px-3 text-sm"
          >
            {EMPLOYMENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`status_${status}`)}
              </option>
            ))}
          </select>
        </div>
        <Button size="sm" onClick={submit} disabled={isPending || target === current}>
          {t("applyStatus")}
        </Button>
      </div>

      {leaving && <p className="text-[11px] text-muted-foreground">{t("deactivationHint")}</p>}

      {/*
        Phase F changes employment status only. Portal access is gated by the
        company membership, which HR does not administer — saying so here is more
        honest than letting someone assume a termination locked the account.
      */}
      {leaving && hasAccount && (
        <p className="text-[11px] text-destructive">{t("accountStillActiveHint")}</p>
      )}

      <NoticeLine notice={notice} />
      <ConflictList conflicts={conflicts} label={t("conflictsAfterStatus")} />
    </div>
  );
}

export type QualificationRow = {
  id: string;
  name: string;
  issued_at: string | null;
  expires_at: string | null;
  status: string;
};

/** Add, retitle, re-date and remove qualifications. No uploads, no documents. */
export function QualificationEditor({
  employeeId,
  rows,
}: {
  employeeId: string;
  rows: QualificationRow[];
}) {
  const t = useTranslations("employees");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [conflicts, setConflicts] = useState<AssignmentConflict[]>([]);
  const [name, setName] = useState("");
  const [expires, setExpires] = useState("");

  function add() {
    setNotice(null);
    setConflicts([]);
    startTransition(async () => {
      const result = await saveQualification({
        employeeId,
        name: name.trim(),
        issued_at: null,
        expires_at: expires || null,
        status: "valid",
      });
      if (!result.ok || result.data.kind === "refused") {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }
      setName("");
      setExpires("");
      setNotice({ text: t("qualificationAdded"), tone: "success" });
      router.refresh();
    });
  }

  function remove(qualificationId: string) {
    setNotice(null);
    setConflicts([]);
    startTransition(async () => {
      const result = await removeQualification({ qualificationId, employeeId });
      if (!result.ok || result.data.kind === "refused") {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }
      setConflicts(result.data.conflicts);
      setNotice({
        text:
          result.data.conflicts.length > 0
            ? t("qualificationRemovedWithConflicts", { count: result.data.conflicts.length })
            : t("qualificationRemoved"),
        tone: "success",
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noQualifications")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
            >
              <span>
                {row.name}
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                  {row.expires_at ? t("until", { date: row.expires_at }) : t("noExpiry")}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => remove(row.id)}
                disabled={isPending}
              >
                {t("remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="qual_name" className="text-xs">
            {t("fieldQualification")}
          </Label>
          <Input
            id="qual_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="max-w-56"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="qual_expires" className="text-xs">
            {t("fieldExpires")}
          </Label>
          <Input
            id="qual_expires"
            type="date"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </div>
        <Button size="sm" variant="outline" onClick={add} disabled={isPending || !name.trim()}>
          {t("add")}
        </Button>
      </div>

      <NoticeLine notice={notice} />
      <ConflictList conflicts={conflicts} label={t("conflictsAfterQualification")} />
    </div>
  );
}
