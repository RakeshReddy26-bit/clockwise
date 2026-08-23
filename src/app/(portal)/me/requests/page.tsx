import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Badge } from "@/components/ui/badge";
import { SiteName } from "@/components/localized-term";

/**
 * The employee's own cancellation requests, newest first.
 *
 * Read-only by design: a request is raised on the shift it belongs to, where
 * the employee can see what they are asking to be released from. This page
 * answers the follow-up question — "what happened to it?".
 */
export const dynamic = "force-dynamic";

type RequestRow = {
  id: string;
  reason: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  shift_assignments: {
    employee_id: string;
    shifts: {
      start_time: string;
      end_time: string;
      jobs: { client_name: string; locations: { name: string } | null } | null;
    } | null;
  } | null;
};

const BADGE: Record<string, "warning" | "success" | "secondary"> = {
  pending: "warning",
  approved: "success",
  rejected: "secondary",
};

export default async function RequestsPage() {
  const ctx = await getShellContext();
  const t = await getTranslations("requests");
  const locale = await getLocale();

  const { data: employee } = await ctx.supabase
    .from("employees")
    .select("id")
    .eq("company_id", ctx.membership.company_id)
    .eq("profile_id", ctx.userId)
    .maybeSingle();

  // cancellations_self_select already scopes these rows to the caller's own
  // assignments; the employee filter is not repeated here because the request
  // row carries no employee_id of its own.
  const { data: rows } = employee
    ? await ctx.supabase
        .from("cancellation_requests")
        .select(
          "id, reason, status, created_at, decided_at, shift_assignments!inner(employee_id, shifts(start_time, end_time, jobs(client_name, locations(name))))"
        )
        .eq("shift_assignments.employee_id", employee.id)
        .order("created_at", { ascending: false })
        .limit(25)
    : { data: [] };

  const requests = (rows ?? []) as unknown as RequestRow[];

  const fmtDateTime = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-xs text-muted-foreground">{t("intro")}</p>
      </div>

      {requests.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          {t("none")}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {requests.map((row) => {
            const shift = row.shift_assignments?.shifts ?? null;
            const siteName = shift?.jobs?.locations?.name ?? null;
            return (
              <li key={row.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {siteName ? <SiteName value={siteName} /> : (shift?.jobs?.client_name ?? "—")}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {shift
                        ? `${fmtDateTime(shift.start_time)}–${fmtTime(shift.end_time)}`
                        : "—"}
                    </p>
                  </div>
                  <Badge variant={BADGE[row.status] ?? "secondary"}>
                    {t(`status_${row.status}`)}
                  </Badge>
                </div>

                <p className="rounded-md bg-secondary p-2 text-xs text-secondary-foreground">
                  {row.reason}
                </p>

                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {t("submittedOn", { when: fmtDateTime(row.created_at) })}
                  {row.decided_at
                    ? ` · ${t("decidedOn", { when: fmtDateTime(row.decided_at) })}`
                    : ""}
                </p>

                {row.status === "pending" && (
                  <p className="text-[11px] text-muted-foreground">{t("stillAssigned")}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
