import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getShellContext } from "@/lib/shell-context";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function HomePage() {
  const ctx = await getShellContext();
  const t = await getTranslations("home");
  const tn = await getTranslations("employeeNav");

  const quickLinks = [
    { href: "/me/calendar", label: tn("calendar") },
    { href: "/me/documents", label: tn("documents") },
    { href: "/me/requests", label: tn("requests") },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("welcome", { name: ctx.profileName })}</CardTitle>
          <CardDescription>{t("foundationNote")}</CardDescription>
        </CardHeader>
      </Card>
      <div className="grid grid-cols-3 gap-2">
        {quickLinks.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="rounded-lg border bg-card p-3 text-center text-xs font-medium transition-colors hover:bg-secondary"
          >
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
