import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";

export async function ComingSoon({ title }: { title: string }) {
  const t = await getTranslations("common");
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card p-8 text-center">
        <Badge variant="secondary">{t("comingSoonTitle")}</Badge>
        <p className="max-w-sm text-sm text-muted-foreground">{t("comingSoon")}</p>
      </div>
    </div>
  );
}
