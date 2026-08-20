import { getTranslations } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DashboardPage() {
  const ctx = await getShellContext();
  const t = await getTranslations("dashboard");

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t("welcome", { name: ctx.profileName })}</CardTitle>
          <CardDescription>{t("foundationNote")}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
