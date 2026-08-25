"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * Shared body for every route-level error boundary.
 *
 * Deliberately does not print the exception: a stack trace on screen during a
 * customer demo reads as an unfinished product, and the digest is enough to
 * find it in the logs.
 */
export function ErrorState({ reset, digest }: { reset: () => void; digest?: string }) {
  const t = useTranslations("common");
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card p-8 text-center">
      <p className="text-sm font-medium">{t("errorTitle")}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{t("error")}</p>
      <Button size="sm" variant="outline" onClick={reset}>
        {t("retry")}
      </Button>
      {digest && <p className="font-mono text-[10px] text-muted-foreground/60">{digest}</p>}
    </div>
  );
}
