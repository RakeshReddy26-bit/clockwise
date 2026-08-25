import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

/**
 * A planned area.
 *
 * Deliberately not a blank "coming soon" panel: during a demo the honest thing
 * is to say what this area will do and point back at the part of the product
 * that works today. `note` carries the one-line description; without it the
 * page falls back to the generic sentence.
 */
export async function ComingSoon({
  title,
  note,
  backHref = "/app",
}: {
  title: string;
  note?: string;
  backHref?: string;
}) {
  const t = await getTranslations("common");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <Badge variant="secondary">{t("comingSoonTitle")}</Badge>
      </div>

      <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card p-8 text-center">
        <p className="max-w-md text-sm text-muted-foreground">{note ?? t("comingSoon")}</p>
        <Link href={backHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {t("backToOverview")}
        </Link>
      </div>
    </div>
  );
}
