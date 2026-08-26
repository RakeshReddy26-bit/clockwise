import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AlertTriangle, UserX, MapPinOff, Clock, Users, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SiteName } from "@/components/localized-term";
import { askAiPromptKey, type AttentionItem, type AttentionKind } from "@/lib/live-ops";

/**
 * The top of the operations board: what needs a decision, worst first.
 *
 * The ranking is `buildAttentionItems`; this component only renders it. Each
 * card carries the two or three facts that let a manager decide without opening
 * anything, then links into the page that can act — the existing shift planner,
 * the existing time board. No action happens here, and no permission is implied
 * by a link: the destination enforces its own.
 */

const ICONS: Record<AttentionKind, typeof AlertTriangle> = {
  no_show: UserX,
  understaffed_active: Users,
  understaffed_upcoming: Users,
  manual_request: Clock,
  outside_geofence: MapPinOff,
  late: Clock,
};

/** Only the top band is red; everything red is nothing red. */
const TONE: Record<AttentionKind, "destructive" | "warning" | "secondary"> = {
  no_show: "destructive",
  understaffed_active: "destructive",
  manual_request: "warning",
  outside_geofence: "warning",
  understaffed_upcoming: "warning",
  late: "secondary",
};

export async function AttentionPanel({
  items,
  total,
}: {
  items: AttentionItem[];
  total: number;
}) {
  const t = await getTranslations("attention");

  if (items.length === 0) {
    return (
      <section className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 p-3">
        <CheckCircle2 className="size-4 shrink-0 text-success" />
        <p className="text-sm font-medium">{t("allClear")}</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <AlertTriangle className="size-4 text-destructive" />
          {t("title")}
        </h2>
        {total > items.length && (
          <p className="text-xs text-muted-foreground">
            {t("andMore", { count: total - items.length })}
          </p>
        )}
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        {items.map((item) => (
          <AttentionCard key={item.key} item={item} />
        ))}
      </div>
    </section>
  );
}

async function AttentionCard({ item }: { item: AttentionItem }) {
  const t = await getTranslations("attention");
  const Icon = ICONS[item.kind];
  const tone = TONE[item.kind];

  const border =
    tone === "destructive"
      ? "border-destructive/40 bg-destructive/5"
      : tone === "warning"
        ? "border-warning/40 bg-warning/5"
        : "border-border bg-card";

  return (
    <article className={`flex flex-col gap-2 rounded-lg border p-3 ${border}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{headline(item, t)}</p>
            <p className="text-xs text-muted-foreground">
              <SiteName value={item.siteName} />
              {" · "}
              {detail(item, t)}
            </p>
          </div>
        </div>
        <Badge variant={tone}>{t(`kind_${item.kind}`)}</Badge>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {item.shiftId && (
          <ActionLink href={`/app/shifts?shift=${item.shiftId}#shift-detail`}>
            {t("viewShift")}
          </ActionLink>
        )}
        {(item.kind === "no_show" ||
          item.kind === "understaffed_active" ||
          item.kind === "understaffed_upcoming") &&
          item.shiftId && (
            <ActionLink
              href={`/app/assistant?ask=${encodeURIComponent(
                t(askAiPromptKey(item), { site: item.siteName })
              )}`}
              primary
            >
              {t("findReplacement")}
            </ActionLink>
          )}
        {item.kind === "manual_request" && (
          <ActionLink href="/app/time" primary>
            {t("reviewRequest")}
          </ActionLink>
        )}
        {item.kind === "outside_geofence" && <ActionLink href="/app/time">{t("openAttendance")}</ActionLink>}
      </div>
    </article>
  );
}

function ActionLink({
  href,
  children,
  primary = false,
}: {
  href: string;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        primary
          ? "rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          : "rounded-md border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      }
    >
      {children}
    </Link>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<"attention">>>;

/** The person or the place, whichever the card is about. */
function headline(item: AttentionItem, t: Translate): string {
  switch (item.kind) {
    case "no_show":
    case "late":
    case "outside_geofence":
    case "manual_request":
      return item.employeeName;
    case "understaffed_active":
    case "understaffed_upcoming":
      return t("seatsOpen", { count: item.openSeats });
  }
}

/** The one number that makes the situation actionable. */
function detail(item: AttentionItem, t: Translate): string {
  switch (item.kind) {
    case "no_show":
      return t("startedMinutesAgo", { count: item.minutesLate });
    case "late":
      return t("lateByMinutes", { count: item.minutesLate });
    case "outside_geofence":
      return item.distanceM === null
        ? t("outsideUnknown")
        : t("metresOutside", { count: item.distanceM });
    case "manual_request":
      return t("waitingMinutes", { count: item.waitingMinutes });
    case "understaffed_active":
      return t("staffedOf", { filled: item.filled, required: item.required });
    case "understaffed_upcoming":
      return `${t("staffedOf", { filled: item.filled, required: item.required })} · ${t(
        "startsInMinutes",
        { count: item.minutesUntilStart }
      )}`;
  }
}
