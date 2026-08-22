import { getTranslations } from "next-intl/server";
import { localizeTerm } from "@/lib/taxonomy";

/**
 * Renders a database-driven taxonomy value (department, role, position) in the
 * active language. Unknown values render exactly as stored.
 *
 * Display only — filters and business logic keep using the raw value or id.
 */
export async function Term({
  value,
  fallback = "—",
}: {
  value: string | null | undefined;
  fallback?: string;
}) {
  if (value == null || value === "") return <>{fallback}</>;
  const t = await getTranslations();
  return <>{localizeTerm(value, (id) => t(id))}</>;
}

/** Same resolution without JSX — for labels built as plain strings. */
export async function localizedTerm(value: string | null | undefined): Promise<string> {
  if (value == null || value === "") return "";
  const t = await getTranslations();
  return localizeTerm(value, (id) => t(id));
}
