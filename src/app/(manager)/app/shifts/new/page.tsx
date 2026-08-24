import { redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { roleHas } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { localizedSite } from "@/components/localized-term";
import { ShiftForm, type JobOption } from "../shift-form";

/**
 * Create a shift. A page rather than a dialog: it is linkable, it keeps the
 * dense planning screen unchanged, and the form stays a file a developer can
 * read in one sitting.
 */
export const dynamic = "force-dynamic";

/** Default: tomorrow, 08:00–16:00, as a datetime-local value. */
function defaultTimes() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(8, 0, 0, 0);
  const end = new Date(start);
  end.setHours(16, 0, 0, 0);
  const local = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes()
    ).padStart(2, "0")}`;
  return { startLocal: local(start), endLocal: local(end) };
}

export default async function NewShiftPage() {
  const ctx = await getShellContext();
  if (!roleHas(ctx.membership.role, "scheduling.manage")) redirect("/app/shifts");

  const t = await getTranslations("shiftForm");

  const { data: jobRows } = await ctx.supabase
    .from("jobs")
    .select("id, client_name, locations(name)")
    .eq("company_id", ctx.membership.company_id)
    .in("status", ["open", "partially_staffed", "fully_staffed"])
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

  const { startLocal, endLocal } = defaultTimes();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{t("newTitle")}</h1>
        <Link href="/app/shifts" className="text-xs text-muted-foreground hover:underline">
          {t("backToPlanning")}
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          {t("noJobs")}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("newSubtitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ShiftForm
              mode="create"
              jobs={jobs}
              initial={{
                jobId: jobs[0].id,
                startLocal,
                endLocal,
                requiredCount: 1,
                requiredRole: "",
                requiredQualification: "",
                instructions: "",
                contactPerson: "",
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
