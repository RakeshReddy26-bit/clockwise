import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/**
 * One empty state for the whole product.
 *
 * An empty screen should say what is missing and offer the one action that
 * fixes it — "Keine Schichten" alone leaves a demo audience wondering whether
 * something is broken.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-card p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {body && <p className="max-w-sm text-xs text-muted-foreground">{body}</p>}
      {action && (
        <Link
          href={action.href}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
