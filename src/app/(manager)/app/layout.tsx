import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getShellContext, brandingStyle } from "@/lib/shell-context";
import { isManagerRole } from "@/lib/permissions";
import { ManagerNav, type NavItem } from "@/components/manager-nav";
import { LanguageToggle } from "@/components/language-toggle";
import { RoleLabel } from "@/components/localized-term";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/(auth)/login/actions";
import { LogOut } from "lucide-react";

export default async function ManagerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getShellContext();
  if (!isManagerRole(ctx.membership.role)) redirect("/me");

  const t = await getTranslations("managerNav");
  const tc = await getTranslations("common");

  const items: NavItem[] = [
    { href: "/app", label: t("dashboard"), icon: "dashboard" },
    { href: "/app/employees", label: t("employees"), icon: "employees" },
    { href: "/app/recruitment", label: t("recruitment"), icon: "recruitment" },
    { href: "/app/jobs", label: t("jobs"), icon: "jobs" },
    { href: "/app/shifts", label: t("shifts"), icon: "shifts" },
    { href: "/app/time", label: t("time"), icon: "time" },
    { href: "/app/absences", label: t("absences"), icon: "absences" },
    { href: "/app/calendar", label: t("calendar"), icon: "calendar" },
    { href: "/app/news", label: t("news"), icon: "news" },
    { href: "/app/messages", label: t("messages"), icon: "messages" },
    { href: "/app/documents", label: t("documents"), icon: "documents" },
    { href: "/app/settings", label: t("settings"), icon: "settings" },
  ];

  return (
    <div
      className="flex min-h-dvh bg-background"
      style={brandingStyle(ctx.company.settings)}
    >
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-card p-3 md:flex">
        <div className="mb-4 flex items-center gap-2 px-1.5 pt-1">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary font-mono text-xs font-semibold text-primary-foreground">
            {ctx.company.name.charAt(0)}
          </span>
          <span className="truncate text-sm font-semibold tracking-tight">
            {ctx.company.name}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ManagerNav items={items} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <Avatar name={ctx.profileName} className="size-7 text-[10px]" />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{ctx.profileName}</p>
              <p className="truncate text-[10px] text-muted-foreground">
                <RoleLabel value={ctx.membership.role} />
              </p>
            </div>
          </div>
          <form action={signOut}>
            <Button
              variant="ghost"
              size="icon"
              type="submit"
              aria-label={tc("signOut")}
              className="size-7"
            >
              <LogOut />
            </Button>
          </form>
        </div>
        <div className="mt-2 flex justify-center">
          <LanguageToggle />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-13 items-center justify-between gap-3 border-b bg-card/95 px-4 backdrop-blur md:hidden">
          <span className="text-sm font-semibold">{ctx.company.name}</span>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <form action={signOut}>
              <Button variant="ghost" size="icon" type="submit" aria-label={tc("signOut")} className="size-8">
                <LogOut />
              </Button>
            </form>
          </div>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b bg-card px-2 py-1.5 md:hidden">
          <ManagerNav items={items} />
        </nav>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
