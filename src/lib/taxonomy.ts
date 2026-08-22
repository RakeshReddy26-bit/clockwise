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
};

/** Stable key for a canonical value, or null when the value is not taxonomy. */
export function termKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return TERM_KEYS[trimmed] ?? null;
}

/**
 * Localize a value with an already-resolved translator.
 * `translate` receives the message id `terms.<key>` and must return the raw id
 * back (or a falsy value) when no message exists — the caller then falls back
 * to the original database value.
 */
export function localizeTerm(
  value: string | null | undefined,
  translate: (id: string) => string
): string {
  if (value == null || value === "") return "";
  const key = termKey(value);
  if (!key) return value; // unknown value → raw database text, always
  const messageId = `terms.${key}`;
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
