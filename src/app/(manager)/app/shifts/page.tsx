import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Term, SiteName, localizedSite } from "@/components/localized-term";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { cn } from "@/lib/utils";
import { loadCandidateInputsForShift, toShiftContext, type ShiftRow } from "@/lib/candidates";
import { rankCandidates, OCCUPYING_ASSIGNMENT_STATUSES, type IneligibleReason } from "@/lib/eligibility";
import { roleHas } from "@/lib/permissions";
import { CancellationRequests } from "@/components/cancellation-requests";
import { OfferPanel, type CandidateView } from "./offer-panel";
import { ResponseActions } from "./response-actions";
import { RemoveAssignment } from "./remove-assignment";
import { CancelShift } from "./cancel-shift";
import { buttonVariants } from "@/components/ui/button";

type ResponseRow = {
  id: string;
  response: string;
  decided_at: string | null;
  resulting_assignment_id: string | null;
  employees: { full_name: string; employee_no: string } | null;
};

/** Interested first — those are the rows a manager can act on. */
const RESPONSE_ORDER: Record<string, number> = {
  interested: 0,
  pending: 1,
  withdrawn: 2,
  declined: 3,
};

/**
 * Shift planning: upcoming shifts with a staffing gap, and — for the selected
 * shift — the ranked candidate list produced by the B1 eligibility engine.
 *
 * Candidate work happens for one shift at a time (the one in ?shift=), so
 * opening the page never evaluates the whole schedule.
 */
export const dynamic = "force-dynamic";

/** Reason codes are internal; managers read these message keys instead. */
const REASON_LABELS: Record<IneligibleReason, string> = {
  not_schedulable: "reasonInactive",
  wrong_company: "reasonWrongCompany",
  role_mismatch: "reasonRoleMismatch",
  missing_qualification: "reasonMissingQualification",
  marked_unavailable: "reasonUnavailable",
  overlapping_assignment: "reasonOverlap",
  on_vacation: "reasonVacation",
  on_sick_leave: "reasonSickLeave",
  already_assigned: "reasonAlreadyAssigned",
};

type RosterRow = {
  id: string;
  status: string;
  employees: { full_name: string; employee_no: string } | null;
};

type ShiftListRow = ShiftRow & {
  status: string;
  required_count: number;
  jobs: { client_name: string; locations: { name: string } | null } | null;
};

export default async function ShiftPlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ shift?: string }>;
}) {
  const ctx = await getShellContext();
  const t = await getTranslations("planning");
  const tc = await getTranslations("cancellation");
  const locale = await getLocale();
  // UX alignment only. removeShiftAssignment() requires the same permission and
  // remove_shift_assignment() re-checks app.is_staff(); hiding a control is
  // never what makes an action safe.
  const canSchedule = roleHas(ctx.membership.role, "scheduling.manage");
  const { shift: selectedShiftId } = await searchParams;

  const { data: shiftRows } = await ctx.supabase
    .from("shifts")
    .select(
      "id, company_id, date, start_time, end_time, status, required_count, required_role, required_qualification, jobs(client_name, locations(name))"
    )
    .eq("company_id", ctx.membership.company_id)
    .in("status", ["open", "staffed"])
    .gte("start_time", new Date().toISOString())
    .order("start_time", { ascending: true })
    .limit(40);

  const shifts = (shiftRows ?? []) as unknown as ShiftListRow[];

  // Seat counts and existing offers for the whole list, in two queries.
  const shiftIds = shifts.map((s) => s.id);
  const [{ data: assignmentRows }, { data: offerRows }] = shiftIds.length
    ? await Promise.all([
        ctx.supabase
          .from("shift_assignments")
          .select("shift_id")
          .in("shift_id", shiftIds)
          .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES]),
        ctx.supabase
          .from("shift_offers")
          .select("id, shift_id")
          .in("shift_id", shiftIds)
          .eq("status", "open"),
      ])
    : [{ data: [] }, { data: [] }];

  const occupiedBy = new Map<string, number>();
  for (const row of (assignmentRows ?? []) as Array<{ shift_id: string }>) {
    occupiedBy.set(row.shift_id, (occupiedBy.get(row.shift_id) ?? 0) + 1);
  }
  const openOfferBy = new Map<string, string>();
  for (const row of (offerRows ?? []) as Array<{ id: string; shift_id: string }>) {
    openOfferBy.set(row.shift_id, row.id);
  }

  const understaffed = shifts.filter(
    (s) => (occupiedBy.get(s.id) ?? 0) < s.required_count
  );

  // Selectable from the whole upcoming list, not only the understaffed part:
  // taking someone off a shift is something a scheduler does to a shift that
  // is currently FULL, and a list that hid those made the action unreachable
  // exactly when it was needed.
  const selected = shifts.find((s) => s.id === selectedShiftId) ?? null;

  // Candidates only for the selected shift.
  let candidates: CandidateView[] = [];
  let responses: ResponseRow[] = [];
  let roster: RosterRow[] = [];
  let remainingSeats = 0;
  if (selected) {
    remainingSeats = selected.required_count - (occupiedBy.get(selected.id) ?? 0);

    // Who is actually on this shift right now. Only occupying statuses: a
    // cancelled assignment is history and has no seat to give back.
    const { data: rosterRows } = await ctx.supabase
      .from("shift_assignments")
      .select("id, status, employees(full_name, employee_no)")
      .eq("shift_id", selected.id)
      .in("status", [...OCCUPYING_ASSIGNMENT_STATUSES])
      .order("created_at", { ascending: true });
    roster = (rosterRows ?? []) as unknown as RosterRow[];

    const inputs = await loadCandidateInputsForShift(ctx.supabase, selected);
    const ranked = rankCandidates(inputs, toShiftContext(selected));

    // A PENDING holiday request covering this day. Deliberately loaded here
    // rather than inside the eligibility engine: it is a note for the manager,
    // never an input to `eligible`. If it went through evaluateCandidate() the
    // next person to read that code would reasonably assume it blocks.
    const pendingVacation = new Set<string>();
    {
      const { data } = await ctx.supabase
        .from("vacation_requests")
        .select("employee_id")
        .eq("company_id", ctx.membership.company_id)
        .eq("status", "pending")
        .lte("start_date", selected.date)
        .gte("end_date", selected.date);
      for (const row of data ?? []) pendingVacation.add(row.employee_id as string);
    }

    const offerId = openOfferBy.get(selected.id);
    const invited = new Set<string>();
    if (offerId) {
      const { data: invitedRows } = await ctx.supabase
        .from("shift_offer_responses")
        .select(
          "id, employee_id, response, decided_at, resulting_assignment_id, employees(full_name, employee_no)"
        )
        .eq("offer_id", offerId);
      const rows = (invitedRows ?? []) as unknown as Array<
        ResponseRow & { employee_id: string }
      >;
      for (const row of rows) invited.add(row.employee_id);
      responses = [...rows].sort(
        (a, b) => (RESPONSE_ORDER[a.response] ?? 9) - (RESPONSE_ORDER[b.response] ?? 9)
      );
    }

    const byId = new Map(inputs.map((i) => [i.employeeId, i]));
    candidates = ranked.map((r) => {
      const input = byId.get(r.employeeId);
      return {
        employeeId: r.employeeId,
        employeeNo: r.employeeNo,
        fullName: r.fullName,
        position: input?.position ?? null,
        department: input?.departmentName ?? null,
        score: r.score,
        eligible: r.eligible,
        reasons: r.reasons.map((reason) => REASON_LABELS[reason]),
        alreadyInvited: invited.has(r.employeeId),
        pendingVacation: pendingVacation.has(r.employeeId),
      };
    });
  }

  // Identity, localized only where it is one of the known demo sites.
  const selectedSiteLabel = selected
    ? (await localizedSite(selected.jobs?.locations?.name ?? null)) ||
      (selected.jobs?.client_name ?? "—")
    : "—";

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { weekday: "short", day: "2-digit", month: "2-digit" });
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col gap-4">
      <RealtimeRefresh
        companyId={ctx.membership.company_id}
        tables={[
          "shifts",
          "shift_assignments",
          "shift_offers",
          "shift_offer_responses",
          "cancellation_requests",
        ]}
      />

      <CancellationRequests
        supabase={ctx.supabase}
        companyId={ctx.membership.company_id}
        canDecide={roleHas(ctx.membership.role, "scheduling.manage")}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">
            {t("understaffedCount", { count: understaffed.length })}
          </p>
          {canSchedule && (
            <Link href="/app/shifts/new" className={buttonVariants({ size: "sm" })}>
              {t("newShift")}
            </Link>
          )}
        </div>
      </div>

      {shifts.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          {t("noUpcoming")}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t("colSite")}</th>
                <th className="px-3 py-2 font-medium">{t("colClient")}</th>
                <th className="px-3 py-2 font-medium">{t("colWhen")}</th>
                <th className="px-3 py-2 font-medium">{t("colRole")}</th>
                <th className="px-3 py-2 font-medium">{t("colQualification")}</th>
                <th className="px-3 py-2 font-medium">{t("colSeats")}</th>
                <th className="px-3 py-2 font-medium">{t("colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => {
                const filled = occupiedBy.get(s.id) ?? 0;
                const open = s.required_count - filled;
                const isSelected = s.id === selected?.id;
                return (
                  <tr
                    key={s.id}
                    className={cn("border-b last:border-b-0", isSelected && "bg-accent/40")}
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={isSelected ? "/app/shifts" : `/app/shifts?shift=${s.id}`}
                        className="font-medium hover:underline"
                      >
                        {s.jobs?.locations?.name ? (
                          <SiteName value={s.jobs.locations.name} />
                        ) : (
                          (s.jobs?.client_name ?? "—")
                        )}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {s.jobs?.client_name ?? "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {fmtDate(s.start_time)} · {fmtTime(s.start_time)}–{fmtTime(s.end_time)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      <Term value={s.required_role} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {s.required_qualification ?? "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {filled}/{s.required_count}{" "}
                      <span className="text-xs text-muted-foreground">
                        ({t("seatsOpen", { count: open })})
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {openOfferBy.has(s.id) ? (
                        <Badge variant="warning">{t("offerPending")}</Badge>
                      ) : open > 0 ? (
                        <Badge variant="destructive">{t("statusUnderstaffed")}</Badge>
                      ) : (
                        <Badge variant="success">{t("statusStaffed")}</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {selected.jobs?.locations?.name ? (
                <SiteName value={selected.jobs.locations.name} />
              ) : (
                (selected.jobs?.client_name ?? "—")
              )}{" "}
              <span className="font-normal text-muted-foreground tabular-nums">
                · {fmtDate(selected.start_time)} {fmtTime(selected.start_time)}–
                {fmtTime(selected.end_time)} · {t("seatsOpen", { count: remainingSeats })}
              </span>
            </CardTitle>

            {canSchedule && (
              <div className="flex flex-wrap items-start gap-2 pt-1">
                <Link
                  href={`/app/shifts/${selected.id}/edit`}
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                >
                  {t("editShift")}
                </Link>
                <CancelShift
                  shiftId={selected.id}
                  siteName={selectedSiteLabel}
                  whenLabel={`${fmtDate(selected.start_time)} ${fmtTime(selected.start_time)}–${fmtTime(selected.end_time)}`}
                  assignedCount={roster.length}
                />
              </div>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {roster.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t("rosterTitle")}</h3>
                <ul className="flex flex-col gap-1">
                  {roster.map((row) => (
                    <li
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{row.employees?.full_name ?? "—"}</span>{" "}
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {row.employees?.employee_no ?? ""}
                        </span>
                        {row.status === "cancellation_requested" && (
                          <Badge variant="warning" className="ml-2">
                            {tc("badge")}
                          </Badge>
                        )}
                      </span>

                      {canSchedule && (
                        <RemoveAssignment
                          assignmentId={row.id}
                          employeeName={row.employees?.full_name ?? ""}
                          siteName={selectedSiteLabel}
                          whenLabel={`${fmtDate(selected.start_time)} ${fmtTime(selected.start_time)}–${fmtTime(selected.end_time)}`}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {responses.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t("responses")}</h3>
                <ul className="flex flex-col gap-1">
                  {responses.map((row) => {
                    const decided = row.decided_at !== null;
                    const approved = decided && row.resulting_assignment_id !== null;
                    return (
                      <li
                        key={row.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
                      >
                        <span className="min-w-0">
                          <span className="font-medium">{row.employees?.full_name ?? "—"}</span>{" "}
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {row.employees?.employee_no ?? ""}
                          </span>
                        </span>

                        <span className="flex items-center gap-2">
                          {decided ? (
                            <Badge variant={approved ? "success" : "secondary"}>
                              {approved ? t("decisionApproved") : t("decisionNotSelected")}
                            </Badge>
                          ) : (
                            <Badge
                              variant={
                                row.response === "interested"
                                  ? "success"
                                  : row.response === "declined"
                                    ? "destructive"
                                    : "secondary"
                              }
                            >
                              {t(`response_${row.response}`)}
                            </Badge>
                          )}

                          {!decided && row.response === "interested" && remainingSeats > 0 && (
                            <ResponseActions
                              responseId={row.id}
                              employeeName={row.employees?.full_name ?? ""}
                            />
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {remainingSeats === 0 && (
                  <p className="text-xs text-muted-foreground">{t("shiftFilled")}</p>
                )}
              </section>
            )}

            <OfferPanel
              shiftId={selected.id}
              candidates={candidates}
              remainingSeats={remainingSeats}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
