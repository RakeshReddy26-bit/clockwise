import { getTranslations, getLocale } from "next-intl/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SiteName } from "@/components/localized-term";
import { CancellationActions } from "@/app/(manager)/app/shifts/cancellation-actions";

/**
 * Pending cancellation requests for the tenant.
 *
 * Rendered above the planning table because it is the one thing on that page
 * that is waiting on the manager rather than the other way round. Decided
 * requests are not listed here — they are history, and the employee sees their
 * own outcome under My requests.
 */

type Row = {
  id: string;
  reason: string;
  created_at: string;
  shift_assignments: {
    id: string;
    employees: { full_name: string; employee_no: string } | null;
    shifts: {
      start_time: string;
      end_time: string;
      required_count: number;
      jobs: { client_name: string; locations: { name: string } | null } | null;
    } | null;
  } | null;
};

export async function CancellationRequests({
  supabase,
  companyId,
  canDecide,
}: {
  supabase: SupabaseClient;
  companyId: string;
  /**
   * Whether this viewer holds `scheduling.manage`. UX alignment only — the
   * decision is refused by the Server Action and again by app.is_staff() in
   * decide_cancellation_request(). Hiding a button is never the authorization.
   * An HR manager still needs to SEE that a request is outstanding; what they
   * do not get is a control that would fail on click.
   */
  canDecide: boolean;
}) {
  const t = await getTranslations("planning");
  const locale = await getLocale();

  const { data } = await supabase
    .from("cancellation_requests")
    .select(
      "id, reason, created_at, shift_assignments!inner(id, employees(full_name, employee_no), shifts(start_time, end_time, required_count, jobs(client_name, locations(name))))"
    )
    .eq("company_id", companyId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(20);

  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) return null;

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("cancellationsTitle")}{" "}
          <span className="font-normal text-muted-foreground tabular-nums">
            ({rows.length})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {canDecide ? t("cancellationsHint") : t("cancellationsReadOnly")}
        </p>
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const shift = row.shift_assignments?.shifts ?? null;
            const siteName = shift?.jobs?.locations?.name ?? null;
            const employee = row.shift_assignments?.employees ?? null;
            return (
              <li
                key={row.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p>
                    <span className="font-medium">{employee?.full_name ?? "—"}</span>{" "}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {employee?.employee_no ?? ""}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {siteName ? <SiteName value={siteName} /> : (shift?.jobs?.client_name ?? "—")}
                    {shift ? ` · ${fmt(shift.start_time)}` : ""}
                  </p>
                  <p className="mt-1 rounded-md bg-secondary p-2 text-xs text-secondary-foreground">
                    {row.reason}
                  </p>
                </div>
                {canDecide ? (
                  <CancellationActions
                    requestId={row.id}
                    employeeName={employee?.full_name ?? ""}
                  />
                ) : (
                  <Badge variant="warning">{t("cancellationPendingBadge")}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
