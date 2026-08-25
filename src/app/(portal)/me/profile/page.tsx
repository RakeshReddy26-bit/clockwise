import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Badge } from "@/components/ui/badge";
import { SiteName } from "@/components/localized-term";
import { EmptyState } from "@/components/empty-state";
import {
  ContactForm,
  AccountForm,
  EmergencyContactForm,
  AvailabilityEditor,
  type EmergencyContactRow,
  type AvailabilityRow,
} from "./profile-forms";

/**
 * The employee's own profile.
 *
 * Split down the middle on purpose: what they maintain, and what HR maintains.
 * The employment block is deliberately shown as plain text rather than disabled
 * inputs — a greyed-out field invites people to try, and the honest message is
 * "this is someone else's to change", not "this is broken".
 */
export const dynamic = "force-dynamic";

type Employee = {
  id: string;
  employee_no: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  position: string | null;
  employment_status: string;
  contract_type: string;
  start_date: string | null;
  weekly_hours: number | null;
  departments: { name: string } | null;
  locations: { name: string } | null;
};

const STATUS_BADGE: Record<string, "success" | "warning" | "secondary"> = {
  active: "success",
  probation: "warning",
  on_leave: "secondary",
  terminated: "secondary",
};

export default async function ProfilePage() {
  const ctx = await getShellContext();
  const t = await getTranslations("profile");
  const locale = await getLocale();

  const { data: profile } = await ctx.supabase
    .from("profiles")
    .select("full_name, locale")
    .eq("id", ctx.userId)
    .maybeSingle();

  const { data } = await ctx.supabase
    .from("employees")
    .select(
      "id, employee_no, full_name, email, phone, position, employment_status, contract_type, start_date, weekly_hours, departments(name), locations(name)"
    )
    .eq("company_id", ctx.membership.company_id)
    .eq("profile_id", ctx.userId)
    .maybeSingle();

  const employee = data as unknown as Employee | null;

  const [{ data: contacts }, { data: availability }, { data: qualifications }] = employee
    ? await Promise.all([
        ctx.supabase
          .from("emergency_contacts")
          .select("id, name, relationship, phone, phone_alt")
          .eq("employee_id", employee.id)
          .limit(1),
        ctx.supabase
          .from("employee_availability")
          .select("id, weekday, start_time, end_time, type")
          .eq("employee_id", employee.id)
          .order("weekday", { nullsFirst: true }),
        ctx.supabase
          .from("employee_qualifications")
          .select("id, name, expires_at, status")
          .eq("employee_id", employee.id)
          .order("name"),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const fmtDate = (value: string) =>
    new Date(`${value}T00:00:00`).toLocaleDateString(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-xs text-muted-foreground">{t("intro")}</p>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
        <h2 className="text-sm font-semibold">{t("sectionAccount")}</h2>
        <AccountForm
          fullName={(profile?.full_name as string) ?? ""}
          locale={(profile?.locale as string) ?? "de"}
        />
      </section>

      {!employee ? (
        <EmptyState title={t("noEmployeeRecord")} />
      ) : (
        <>
          <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <h2 className="text-sm font-semibold">{t("sectionContact")}</h2>
            <ContactForm phone={employee.phone ?? ""} />
          </section>

          <section className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{t("sectionEmployment")}</h2>
              <Badge variant={STATUS_BADGE[employee.employment_status] ?? "secondary"}>
                {t(`status_${employee.employment_status}`)}
              </Badge>
            </div>
            <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              <dt className="text-muted-foreground">{t("fieldEmployeeNo")}</dt>
              <dd className="tabular-nums">{employee.employee_no}</dd>
              <dt className="text-muted-foreground">{t("fieldName")}</dt>
              <dd>{employee.full_name}</dd>
              <dt className="text-muted-foreground">{t("fieldContract")}</dt>
              <dd>{t(`contract_${employee.contract_type}`)}</dd>
              <dt className="text-muted-foreground">{t("fieldWeeklyHours")}</dt>
              <dd className="tabular-nums">{employee.weekly_hours ?? "—"}</dd>
              <dt className="text-muted-foreground">{t("fieldPosition")}</dt>
              <dd>{employee.position ?? "—"}</dd>
              <dt className="text-muted-foreground">{t("fieldDepartment")}</dt>
              <dd>{employee.departments?.name ?? "—"}</dd>
              <dt className="text-muted-foreground">{t("fieldSite")}</dt>
              <dd>
                {employee.locations?.name ? <SiteName value={employee.locations.name} /> : "—"}
              </dd>
              <dt className="text-muted-foreground">{t("fieldStartDate")}</dt>
              <dd className="tabular-nums">
                {employee.start_date ? fmtDate(employee.start_date) : "—"}
              </dd>
              <dt className="text-muted-foreground">{t("fieldEmail")}</dt>
              <dd>{employee.email ?? "—"}</dd>
            </dl>
            <p className="text-[11px] text-muted-foreground">{t("employmentOwnedByHr")}</p>
          </section>

          <section className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <h2 className="text-sm font-semibold">{t("sectionQualifications")}</h2>
            {(qualifications ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noQualifications")}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs">
                {(
                  (qualifications ?? []) as Array<{
                    id: string;
                    name: string;
                    expires_at: string | null;
                    status: string;
                  }>
                ).map((q) => (
                  <li key={q.id} className="flex items-center justify-between gap-2">
                    <span>{q.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {q.expires_at ? t("until", { date: fmtDate(q.expires_at) }) : t("noExpiry")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground">{t("qualificationsOwnedByHr")}</p>
          </section>

          <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <h2 className="text-sm font-semibold">{t("sectionAvailability")}</h2>
            <AvailabilityEditor rows={(availability ?? []) as AvailabilityRow[]} />
          </section>

          <section className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <h2 className="text-sm font-semibold">{t("sectionEmergency")}</h2>
            <p className="text-[11px] text-muted-foreground">{t("emergencyHint")}</p>
            <EmergencyContactForm
              contact={((contacts ?? [])[0] as EmergencyContactRow | undefined) ?? null}
            />
          </section>
        </>
      )}
    </div>
  );
}
