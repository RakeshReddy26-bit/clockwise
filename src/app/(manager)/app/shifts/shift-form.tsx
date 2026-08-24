"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { createShift, updateShift } from "./shift-actions";

export type JobOption = { id: string; label: string };

export type ShiftFormValues = {
  jobId: string;
  /** `YYYY-MM-DDTHH:mm`, the value shape of an <input type="datetime-local">. */
  startLocal: string;
  endLocal: string;
  requiredCount: number;
  requiredRole: string;
  requiredQualification: string;
  instructions: string;
  contactPerson: string;
};

/**
 * One form for both creating and editing a shift.
 *
 * Client-side validation here is a courtesy: create_shift() and update_shift()
 * re-check every rule and are the only authority. What this component really
 * does is turn a refusal code into a sentence, and put the confirmation step
 * in front of an edit that would invalidate an invitation people have already
 * received.
 */
export function ShiftForm({
  mode,
  jobs,
  shiftId,
  initial,
}: {
  mode: "create" | "edit";
  jobs: JobOption[];
  shiftId?: string;
  initial: ShiftFormValues;
}) {
  const t = useTranslations("shiftForm");
  const tp = useTranslations("planning");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [values, setValues] = useState<ShiftFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{
    changed: string[];
    interested: number;
  } | null>(null);

  function set<K extends keyof ShiftFormValues>(key: K, value: ShiftFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setPendingConfirm(null);
    setError(null);
  }

  /**
   * A datetime-local value carries no zone, so it is read in the browser's own
   * timezone — which for this product is the same German clock the schedule is
   * written in. The server derives the shift's calendar date itself and never
   * trusts a date from here.
   */
  const toIso = (local: string) => new Date(local).toISOString();

  function submit(confirm: boolean) {
    setError(null);
    startTransition(async () => {
      const result =
        mode === "create"
          ? await createShift({
              jobId: values.jobId,
              startTime: toIso(values.startLocal),
              endTime: toIso(values.endLocal),
              requiredCount: values.requiredCount,
              requiredRole: values.requiredRole || undefined,
              requiredQualification: values.requiredQualification || undefined,
              instructions: values.instructions || undefined,
              contactPerson: values.contactPerson || undefined,
            })
          : await updateShift({
              shiftId: shiftId!,
              confirm,
              patch: {
                jobId: values.jobId,
                startTime: toIso(values.startLocal),
                endTime: toIso(values.endLocal),
                requiredCount: values.requiredCount,
                requiredRole: values.requiredRole || null,
                requiredQualification: values.requiredQualification || null,
                instructions: values.instructions || null,
                contactPerson: values.contactPerson || null,
              },
            });

      if (!result.ok) {
        setError(tp("errorGeneric"));
        return;
      }

      const data = result.data;

      if (data.kind === "refused") {
        // `count` is only meaningful for below_occupancy / has_assignments;
        // the other messages ignore it.
        const count =
          "occupancy" in data ? (data.occupancy ?? data.assignments ?? 0) : 0;
        setError(t(`refused_${data.status}`, { count }));
        return;
      }
      if (data.kind === "unchanged") {
        router.push("/app/shifts");
        return;
      }
      if (data.kind === "confirm") {
        setPendingConfirm({ changed: data.changed, interested: data.interested });
        return;
      }

      const target =
        data.kind === "created" ? `/app/shifts?shift=${data.shiftId}` : `/app/shifts?shift=${shiftId}`;
      router.push(target);
      router.refresh();
    });
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("job")} htmlFor="jobId" className="sm:col-span-2">
          <select
            id="jobId"
            required
            value={values.jobId}
            onChange={(e) => set("jobId", e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
          >
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t("jobHint")}</p>
        </Field>

        <Field label={t("start")} htmlFor="start">
          <Input
            id="start"
            type="datetime-local"
            required
            value={values.startLocal}
            onChange={(e) => set("startLocal", e.target.value)}
          />
        </Field>

        <Field label={t("end")} htmlFor="end">
          <Input
            id="end"
            type="datetime-local"
            required
            value={values.endLocal}
            onChange={(e) => set("endLocal", e.target.value)}
          />
        </Field>

        <Field label={t("requiredCount")} htmlFor="count">
          <Input
            id="count"
            type="number"
            min={1}
            max={200}
            required
            value={values.requiredCount}
            onChange={(e) => set("requiredCount", Number(e.target.value))}
          />
        </Field>

        <Field label={t("role")} htmlFor="role">
          <Input
            id="role"
            value={values.requiredRole}
            maxLength={120}
            placeholder={t("optional")}
            onChange={(e) => set("requiredRole", e.target.value)}
          />
        </Field>

        <Field label={t("qualification")} htmlFor="qualification">
          <Input
            id="qualification"
            value={values.requiredQualification}
            maxLength={120}
            placeholder={t("optional")}
            onChange={(e) => set("requiredQualification", e.target.value)}
          />
        </Field>

        <Field label={t("contactPerson")} htmlFor="contact">
          <Input
            id="contact"
            value={values.contactPerson}
            maxLength={200}
            placeholder={t("optional")}
            onChange={(e) => set("contactPerson", e.target.value)}
          />
        </Field>

        <Field label={t("instructions")} htmlFor="instructions" className="sm:col-span-2">
          <textarea
            id="instructions"
            rows={3}
            maxLength={2000}
            value={values.instructions}
            placeholder={t("optional")}
            onChange={(e) => set("instructions", e.target.value)}
            className="rounded-md border border-input bg-card p-2 text-sm"
          />
        </Field>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {pendingConfirm && (
        <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
          <p className="text-sm font-medium text-warning">{t("confirmTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {t("confirmBody", { count: pendingConfirm.interested })}
          </p>
          <ul className="list-inside list-disc text-xs text-muted-foreground">
            {pendingConfirm.changed.map((field) => (
              <li key={field}>{t(`field_${field}`)}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => submit(true)} disabled={isPending}>
              {t("confirmAction")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setPendingConfirm(null)}
              disabled={isPending}
            >
              {t("back")}
            </Button>
          </div>
        </div>
      )}

      {!pendingConfirm && (
        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {mode === "create" ? t("createAction") : t("saveAction")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push("/app/shifts")}
            disabled={isPending}
          >
            {t("cancelAction")}
          </Button>
        </div>
      )}
    </form>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
