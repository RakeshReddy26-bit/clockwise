import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";

export default async function NotFound() {
  const t = await getTranslations("employees");
  const tc = await getTranslations("common");
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card p-8 text-center">
      <p className="text-sm font-medium">{tc("notFoundTitle")}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{tc("notFound")}</p>
      <Link href="/app/employees" className={buttonVariants({ variant: "outline", size: "sm" })}>
        {t("title")}
      </Link>
    </div>
  );
}
