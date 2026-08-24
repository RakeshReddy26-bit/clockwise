"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createEmployee, updateEmployee } from "./actions";

/**
 * The one form for creating and editing an employment record.
 *
 * Every field here is HR-owned (see EMPLOYEE_FIELDS in lib/employee.ts). Two
 * things are deliberately absent:
 *
 *   employment_status — it has consequences a field edit does not, so it lives
 *   in its own control with its own confirmation of what it collided with.
 *
 *   vacation_days_total / _used — nothing in the product maintains them, and a
 *   number the system does not compute is a lie on the page.
 */

export type EmployeeFormValues = {
  employee_no: string;
  full_name: string;
  email: string;
  phone: string;
  position: string;
  department_id: string;
  location_id: string;
  contract_type: string;
  start_date: string;
  weekly_hours: string;
  hourly_rate: string;
};

export type Option = { id: string; name: string };

const EMPTY: EmployeeFormValues = {
  employee_no: "",
  full_name: "",
  email: "",
  phone: "",
  position: "",
  department_id: "",
  location_id: "",
  contract_type: "full_time",
  start_date: "",
  weekly_hours: "",
  hourly_rate: "",
};

const CONTRACT_TYPES = ["full_time", "part_time", "mini_job", "temporary"] as const;

function text(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function num(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function EmployeeForm({
  employeeId,
  initial,
  departments,
  locations,
}: {
  /** Absent for a new record. */
  employeeId?: string;
  initial?: Partial<EmployeeFormValues>;
  departments: Option[];
  locations: Option[];
}) {
  const t = useTranslations("employees");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [values, setValues] = useState<EmployeeFormValues>({ ...EMPTY, ...initial });
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "error" } | null>(null);

  const set = (key: keyof EmployeeFormValues) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  function submit() {
    setNotice(null);
    startTransition(async () => {
      const payload = {
        employee_no: values.employee_no.trim(),
        full_name: values.full_name.trim(),
        email: text(values.email),
        phone: text(values.phone),
        position: text(values.position),
        department_id: text(values.department_id),
        location_id: text(values.location_id),
        contract_type: values.contract_type as (typeof CONTRACT_TYPES)[number],
        start_date: text(values.start_date),
        weekly_hours: num(values.weekly_hours),
        hourly_rate: num(values.hourly_rate),
      };

      const result = employeeId
        ? await updateEmployee({ ...payload, employeeId })
        : await createEmployee({ ...payload, employment_status: "active" });

      if (!result.ok) {
        setNotice({ text: t("errorGeneric"), tone: "error" });
        return;
      }
      if (result.data.kind === "refused") {
        setNotice({ text: t("refused_duplicate_employee_no"), tone: "error" });
        return;
      }
      if (result.data.kind === "created") {
        router.push(`/app/employees/${result.data.employeeId}`);
        return;
      }
      setNotice({ text: t("saved"), tone: "success" });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
        <h2 className="text-sm font-semibold">{t("sectionIdentity")}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field id="employee_no" label={t("fieldEmployeeNo")}>
            <Input
              id="employee_no"
              value={values.employee_no}
              onChange={(e) => set("employee_no")(e.target.value)}
            />
          </Field>
          <Field id="full_name" label={t("fieldFullName")}>
            <Input
              id="full_name"
              value={values.full_name}
              onChange={(e) => set("full_name")(e.target.value)}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
        <h2 className="text-sm font-semibold">{t("sectionEmployment")}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field id="contract_type" label={t("fieldContract")}>
            <select
              id="contract_type"
              value={values.contract_type}
              onChange={(e) => set("contract_type")(e.target.value)}
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
            >
              {CONTRACT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`contract_${type}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="start_date" label={t("fieldStartDate")}>
            <Input
              id="start_date"
              type="date"
              value={values.start_date}
              onChange={(e) => set("start_date")(e.target.value)}
            />
          </Field>
          <Field id="position" label={t("fieldPosition")}>
            <Input
              id="position"
              value={values.position}
              onChange={(e) => set("position")(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{t("positionHint")}</p>
          </Field>
          <Field id="department_id" label={t("fieldDepartment")}>
            <Select
              id="department_id"
              value={values.department_id}
              onChange={set("department_id")}
              options={departments}
              emptyLabel={t("noneOption")}
            />
          </Field>
          <Field id="location_id" label={t("fieldSite")}>
            <Select
              id="location_id"
              value={values.location_id}
              onChange={set("location_id")}
              options={locations}
              emptyLabel={t("noneOption")}
            />
          </Field>
          <Field id="weekly_hours" label={t("fieldWeeklyHours")}>
            <Input
              id="weekly_hours"
              inputMode="decimal"
              value={values.weekly_hours}
              onChange={(e) => set("weekly_hours")(e.target.value)}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
        <h2 className="text-sm font-semibold">{t("sectionContact")}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field id="email" label={t("fieldEmail")}>
            <Input
              id="email"
              type="email"
              value={values.email}
              onChange={(e) => set("email")(e.target.value)}
            />
          </Field>
          <Field id="phone" label={t("fieldPhone")}>
            <Input id="phone" value={values.phone} onChange={(e) => set("phone")(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">{t("phoneHint")}</p>
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
        <h2 className="text-sm font-semibold">{t("sectionPay")}</h2>
        <Field id="hourly_rate" label={t("fieldHourlyRate")}>
          <Input
            id="hourly_rate"
            inputMode="decimal"
            className="max-w-40"
            value={values.hourly_rate}
            onChange={(e) => set("hourly_rate")(e.target.value)}
          />
        </Field>
      </section>

      <div className="flex items-center justify-between gap-2">
        {notice ? (
          <p
            role="status"
            className={`text-xs ${
              notice.tone === "success" ? "text-success" : "text-destructive"
            }`}
          >
            {notice.text}
          </p>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          onClick={submit}
          disabled={isPending || !values.employee_no.trim() || !values.full_name.trim()}
        >
          {employeeId ? t("save") : t("create")}
        </Button>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

function Select({
  id,
  value,
  onChange,
  options,
  emptyLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  emptyLabel: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-input bg-card px-3 text-sm"
    >
      <option value="">{emptyLabel}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  );
}
