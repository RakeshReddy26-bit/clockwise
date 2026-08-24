import { getTranslations, getLocale } from "next-intl/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SiteName } from "@/components/localized-term";

/**
 * "You were taken off this shift" — the employee-facing half of a manager
 * removal.
 *
 * Without it the shift simply disappears from My shifts, which is the same
 * disappearing-card problem the offer flow had: the employee cannot tell a
 * schedule change from a bug. Deliberately small — it reads the notification
 * the removal already wrote, shows the recent ones, and does nothing else.
 * This is not a notification centre and should not grow into one here.
 */

const RECENT_DAYS = 7;

type NotificationRow = {
  id: string;
  created_at: string;
  payload: {
    shift_id?: string;
    site_name?: string | null;
    start_time?: string | null;
    end_time?: string | null;
  } | null;
};

export async function RemovalNotices({
  supabase,
  profileId,
  companyId,
}: {
  supabase: SupabaseClient;
  profileId: string;
  companyId: string;
}) {
  const t = await getTranslations("removal");
  const locale = await getLocale();

  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();

  // notifications_self_select already scopes these to the caller; the explicit
  // filters make the intent visible rather than implicit.
  const { data } = await supabase
    .from("notifications")
    .select("id, created_at, payload")
    .eq("company_id", companyId)
    .eq("profile_id", profileId)
    .eq("type", "assignment_removed")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5);

  const rows = (data ?? []) as unknown as NotificationRow[];
  if (rows.length === 0) return null;

  const fmt = (iso: string | null | undefined) => {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleString(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-muted-foreground">{t("sectionTitle")}</h2>
      {rows.map((row) => {
        const when = fmt(row.payload?.start_time);
        const site = row.payload?.site_name ?? null;
        return (
          <div key={row.id} className="rounded-lg border bg-card p-3">
            <p className="text-sm font-medium">{t("title")}</p>
            <p className="text-xs text-muted-foreground">
              {site ? <SiteName value={site} /> : null}
              {site && when ? " · " : null}
              {when ? <span className="tabular-nums">{when}</span> : null}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t("body")}</p>
          </div>
        );
      })}
    </section>
  );
}
