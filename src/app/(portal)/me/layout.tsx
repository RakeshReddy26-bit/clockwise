import { getTranslations } from "next-intl/server";
import { getShellContext, brandingStyle } from "@/lib/shell-context";
import { PortalNav, type PortalNavItem } from "@/components/portal-nav";
import { LanguageToggle } from "@/components/language-toggle";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/(auth)/login/actions";
import { LogOut } from "lucide-react";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getShellContext();
  const t = await getTranslations("employeeNav");
  const tc = await getTranslations("common");

  // Five slots on a phone, so they go to what an employee actually opens during
  // a working week. Messages is a planned area and would spend a slot on a dead
  // end; it stays reachable from the home screen's quick links.
  const items: PortalNavItem[] = [
    { href: "/me", label: t("home"), icon: "home" },
    { href: "/me/shifts", label: t("shifts"), icon: "shifts" },
    { href: "/me/time", label: t("time"), icon: "time" },
    { href: "/me/absences", label: t("absences"), icon: "absences" },
    { href: "/me/profile", label: t("profile"), icon: "profile" },
  ];

  return (
    <div
      className="flex min-h-dvh flex-col bg-background"
      style={brandingStyle(ctx.company.settings)}
    >
      <header className="sticky top-0 z-30 flex h-13 items-center justify-between border-b bg-card/95 px-4 backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary font-mono text-xs font-semibold text-primary-foreground">
            {ctx.company.name.charAt(0)}
          </span>
          <span className="text-sm font-semibold">{ctx.company.name}</span>
        </div>
        <div className="flex items-center gap-1">
          <LanguageToggle />
          <form action={signOut}>
            <Button
              variant="ghost"
              size="icon"
              type="submit"
              aria-label={tc("signOut")}
              className="size-8"
            >
              <LogOut />
            </Button>
          </form>
        </div>
      </header>

      <main className="mx-auto w-full max-w-lg flex-1 p-4 pb-24">{children}</main>

      <PortalNav items={items} />
    </div>
  );
}
