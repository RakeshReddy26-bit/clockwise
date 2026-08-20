"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  CalendarClock,
  Timer,
  MessageSquare,
  User,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type PortalNavItem = { href: string; label: string; icon: string };

const ICONS: Record<string, LucideIcon> = {
  home: Home,
  shifts: CalendarClock,
  time: Timer,
  messages: MessageSquare,
  profile: User,
};

export function PortalNav({ items }: { items: PortalNavItem[] }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card pb-[env(safe-area-inset-bottom)]"
    >
      <div className="mx-auto grid max-w-lg grid-cols-5">
        {items.map((item) => {
          const Icon = ICONS[item.icon] ?? Home;
          const active =
            item.href === "/me" ? pathname === "/me" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors",
                active ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Icon className="size-5" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
