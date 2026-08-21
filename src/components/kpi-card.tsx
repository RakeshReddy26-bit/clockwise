import Link from "next/link";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "good" | "warn" | "critical";

const TONE_VALUE: Record<Tone, string> = {
  neutral: "text-foreground",
  good: "text-success",
  warn: "text-warning",
  critical: "text-destructive",
};

const TONE_RAIL: Record<Tone, string> = {
  neutral: "bg-border",
  good: "bg-success",
  warn: "bg-warning",
  critical: "bg-destructive",
};

export function KpiCard({
  label,
  value,
  tone = "neutral",
  hint,
  href,
}: {
  label: string;
  value: number;
  tone?: Tone;
  hint?: string;
  href?: string;
}) {
  const body = (
    <div className="relative flex flex-col gap-0.5 overflow-hidden rounded-lg border bg-card p-3 pl-4">
      <span className={cn("absolute inset-y-0 left-0 w-1", TONE_RAIL[tone])} aria-hidden />
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn("text-2xl font-semibold tabular-nums leading-tight", TONE_VALUE[tone])}>
        {value}
      </span>
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );

  return href ? (
    <Link href={href} className="transition-opacity hover:opacity-80">
      {body}
    </Link>
  ) : (
    body
  );
}
