import { getLocale, getTranslations } from "next-intl/server";
import { setLocale } from "@/app/actions/locale";
import { cn } from "@/lib/utils";

export async function LanguageToggle({ className }: { className?: string }) {
  const current = await getLocale();
  const t = await getTranslations("common");

  return (
    <form
      action={setLocale}
      className={cn("inline-flex items-center gap-1 text-xs", className)}
      aria-label={t("language")}
    >
      {(["de", "en"] as const).map((l) => (
        <button
          key={l}
          type="submit"
          name="locale"
          value={l}
          disabled={l === current}
          className={cn(
            "rounded px-2 py-1 font-medium uppercase tracking-wide transition-colors",
            l === current
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-secondary"
          )}
        >
          {l}
        </button>
      ))}
    </form>
  );
}
