import { getTranslations } from "next-intl/server";
import { localizeTerm, localizeSite, localizeRole } from "@/lib/taxonomy";

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

/**
 * Renders a worksite name. Known demo sites are localized; tenant-created and
 * client-owned locations render exactly as stored.
 */
export async function SiteName({
  value,
  fallback = "—",
}: {
  value: string | null | undefined;
  fallback?: string;
}) {
  if (value == null || value === "") return <>{fallback}</>;
  const t = await getTranslations();
  return <>{localizeSite(value, (id) => t(id))}</>;
}

/** String form — for filter labels and props passed to client components. */
export async function localizedSite(value: string | null | undefined): Promise<string> {
  if (value == null || value === "") return "";
  const t = await getTranslations();
  return localizeSite(value, (id) => t(id));
}

/** Renders a system role enum as a readable label. */
export async function RoleLabel({ value }: { value: string | null | undefined }) {
  if (value == null || value === "") return null;
  const t = await getTranslations();
  return <>{localizeRole(value, (id) => t(id))}</>;
}
