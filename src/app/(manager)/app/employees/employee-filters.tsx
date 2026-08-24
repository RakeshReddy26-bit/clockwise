"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { EMPLOYMENT_STATUSES } from "@/lib/employee";

/**
 * Status and free-text filtering, kept in the URL so a filtered list is a link
 * a dispatcher can send to somebody. Filters only on data the schema actually
 * has — there is no clever search here on purpose.
 */
export function EmployeeFilters({ status, q }: { status: string; q: string }) {
  const t = useTranslations("employees");
  const router = useRouter();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function apply(next: Record<string, string>) {
    const search = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value && value !== "all") search.set(key, value);
      else search.delete(key);
    }
    startTransition(() => router.push(`/app/employees?${search.toString()}`));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1">
        {["all", ...EMPLOYMENT_STATUSES].map((value) => (
          <button
            key={value}
            type="button"
            disabled={isPending}
            onClick={() => apply({ status: value })}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              status === value
                ? "border-transparent bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:bg-secondary"
            }`}
          >
            {value === "all" ? t("filterAll") : t(`status_${value}`)}
          </button>
        ))}
      </div>
      <Input
        defaultValue={q}
        placeholder={t("searchPlaceholder")}
        aria-label={t("searchPlaceholder")}
        className="h-8 max-w-56 text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter") apply({ q: (e.target as HTMLInputElement).value });
        }}
      />
    </div>
  );
}
