import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { roleHas } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { localizedSite } from "@/components/localized-term";
import { ShiftForm, type JobOption } from "../../shift-form";

export const dynamic = "force-dynamic";

/** A timestamptz rendered as the datetime-local value shape, in local time. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export default async function EditShiftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getShellContext();
  if (!roleHas(ctx.membership.role, "scheduling.manage")) redirect("/app/shifts");

  const { id } = await params;
  const t = await getTranslations("shiftForm");

  const { data: shift } = await ctx.supabase
    .from("shifts")
    .select(
      "id, company_id, job_id, start_time, end_time, required_count, required_role, required_qualification, instructions, contact_person, status"
    )
    .eq("id", id)
    .maybeSingle();

  if (!shift || shift.company_id !== ctx.membership.company_id) notFound();

  const { data: jobRows } = await ctx.supabase
    .from("jobs")
    .select("id, client_name, locations(name)")
    .eq("company_id", ctx.membership.company_id)
    .order("client_name");

  const jobs: JobOption[] = await Promise.all(
    ((jobRows ?? []) as unknown as Array<{
      id: string;
      client_name: string;
      locations: { name: string } | null;
    }>).map(async (job) => {
      const site = await localizedSite(job.locations?.name ?? null);
      return { id: job.id, label: site ? `${job.client_name} · ${site}` : job.client_name };
    })
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{t("editTitle")}</h1>
        <Link
          href={`/app/shifts?shift=${shift.id}`}
          className="text-xs text-muted-foreground hover:underline"
        >
          {t("backToPlanning")}
        </Link>
      </div>

      {shift.status === "cancelled" ? (
        <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          {t("refused_shift_cancelled", { count: 0 })}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("editSubtitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ShiftForm
              mode="edit"
              shiftId={shift.id}
              jobs={jobs}
              initial={{
                jobId: shift.job_id,
                startLocal: toLocalInput(shift.start_time),
                endLocal: toLocalInput(shift.end_time),
                requiredCount: shift.required_count,
                requiredRole: shift.required_role ?? "",
                requiredQualification: shift.required_qualification ?? "",
                instructions: shift.instructions ?? "",
                contactPerson: shift.contact_person ?? "",
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
