/**
 * Operational taxonomy — stable term keys for database-driven values.
 *
 * The database stores canonical (German) values. The UI renders them through
 * a stable key so DE/EN can differ without ever rewriting data on a language
 * change. Anything not in this map renders exactly as stored, which is what
 * keeps tenant-specific departments, client names, and site names intact.
 *
 * NEVER add company names, employee names, client names, site/location names,
 * addresses, or free text here — those are identities, not taxonomy.
 */

export const TERM_KEYS: Record<string, string> = {
  // Departments / service lines
  "Gebäudetechnik": "building_services",
  Reinigung: "cleaning",
  "Logistik & Event": "logistics_events",

  // Positions / roles
  Reinigungskraft: "cleaner",
  "Haustechniker/in": "building_technician",
  "Lagerhelfer/in": "warehouse_assistant",
  Servicekraft: "service_staff",
  Empfangskraft: "receptionist",
  "Vorarbeiter/in": "team_lead",
  "Hausmeister/in": "caretaker",
  "Logistikmitarbeiter/in": "logistics_worker",
  "Parkservice-Mitarbeiter/in": "parking_attendant",
  "Terminalmitarbeiter/in": "terminal_staff",
  "Servicetechniker/in": "service_technician",
  "Wartungstechniker/in": "maintenance_technician",
};

/** Stable key for a canonical value, or null when the value is not taxonomy. */
export function termKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return TERM_KEYS[trimmed] ?? null;
}

/**
 * Known demo worksites. Deliberately a SEPARATE map from TERM_KEYS so a
 * department or role can never be resolved as a site, or the other way round.
 *
 * Only the seeded demo sites belong here. Tenant-created locations — and
 * client-owned worksites such as "GE-PACK Services – Werk Nord" — are
 * identities and must render exactly as stored.
 */
export const SITE_KEYS: Record<string, string> = {
  "Zentrale Berlin-Mitte": "hq_berlin_mitte",
  "Bürocampus Adlershof": "office_campus_adlershof",
  "Logistikpark Großbeeren": "logistics_park_grossbeeren",
  "Einkaufszentrum Spandau": "shopping_center_spandau",
  "Klinikum Buch": "hospital_buch",
};

/** Stable key for a known demo site, or null for any other location. */
export function siteKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return SITE_KEYS[trimmed] ?? null;
}

/**
 * System role enum labels. The database keeps the enum value; only the display
 * label is localized. Enum strings are never rewritten.
 */
export const ROLE_KEYS = [
  "SUPER_ADMIN",
  "COMPANY_ADMIN",
  "HR_MANAGER",
  "DISPATCHER",
  "EMPLOYEE",
  "APPLICANT",
] as const;

export function roleKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return (ROLE_KEYS as readonly string[]).includes(trimmed) ? trimmed : null;
}

/**
 * Localize a value with an already-resolved translator.
 * `translate` receives the message id `terms.<key>` and must return the raw id
 * back (or a falsy value) when no message exists — the caller then falls back
 * to the original database value.
 */
function localizeWithNamespace(
  value: string | null | undefined,
  key: string | null,
  namespace: string,
  translate: (id: string) => string
): string {
  if (value == null || value === "") return "";
  if (!key) return value; // unknown value → raw database text, always
  const messageId = `${namespace}.${key}`;
  try {
    const translated = translate(messageId);
    if (!translated || translated === messageId || translated.endsWith(`.${key}`)) {
      return value;
    }
    return translated;
  } catch {
    return value;
  }
}

export function localizeTerm(
  value: string | null | undefined,
  translate: (id: string) => string
): string {
  return localizeWithNamespace(value, termKey(value), "terms", translate);
}

/** Known demo worksites only; every other location renders as stored. */
export function localizeSite(
  value: string | null | undefined,
  translate: (id: string) => string
): string {
  return localizeWithNamespace(value, siteKey(value), "sites", translate);
}

/** System role enum → display label; unknown values render as stored. */
export function localizeRole(
  value: string | null | undefined,
  translate: (id: string) => string
): string {
  return localizeWithNamespace(value, roleKey(value), "roles", translate);
}
