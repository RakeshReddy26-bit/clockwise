import { describe, expect, it } from "vitest";
import {
  termKey,
  localizeTerm,
  TERM_KEYS,
  siteKey,
  localizeSite,
  SITE_KEYS,
  roleKey,
  localizeRole,
  ROLE_KEYS,
} from "@/lib/taxonomy";
import de from "@/messages/de.json";
import en from "@/messages/en.json";

/** Translator stub mimicking next-intl: returns the id when no message exists. */
function translator(messages: Record<string, Record<string, string>>) {
  return (id: string) => {
    const [ns, key] = id.split(".");
    return messages[ns]?.[key] ?? id;
  };
}

const t_de = translator(de as unknown as Record<string, Record<string, string>>);
const t_en = translator(en as unknown as Record<string, Record<string, string>>);

describe("term keys", () => {
  it("maps departments and roles to stable keys", () => {
    expect(termKey("Gebäudetechnik")).toBe("building_services");
    expect(termKey("Reinigung")).toBe("cleaning");
    expect(termKey("Logistik & Event")).toBe("logistics_events");
    expect(termKey("Reinigungskraft")).toBe("cleaner");
    expect(termKey("Haustechniker/in")).toBe("building_technician");
    expect(termKey("Lagerhelfer/in")).toBe("warehouse_assistant");
    expect(termKey("Servicekraft")).toBe("service_staff");
    expect(termKey("Empfangskraft")).toBe("receptionist");
    expect(termKey("Vorarbeiter/in")).toBe("team_lead");
    expect(termKey("Hausmeister/in")).toBe("caretaker");
  });

  it("tolerates surrounding whitespace", () => {
    expect(termKey("  Reinigung  ")).toBe("cleaning");
  });

  it("returns null for anything outside the taxonomy", () => {
    expect(termKey("Sonderdienst")).toBeNull();
    expect(termKey("")).toBeNull();
    expect(termKey(null)).toBeNull();
    expect(termKey(undefined)).toBeNull();
  });
});

describe("localizeTerm", () => {
  it("renders English labels when English is active", () => {
    expect(localizeTerm("Gebäudetechnik", t_en)).toBe("Building Services");
    expect(localizeTerm("Reinigung", t_en)).toBe("Cleaning");
    expect(localizeTerm("Logistik & Event", t_en)).toBe("Logistics & Events");
    expect(localizeTerm("Reinigungskraft", t_en)).toBe("Cleaner");
    expect(localizeTerm("Vorarbeiter/in", t_en)).toBe("Team Lead");
    expect(localizeTerm("Hausmeister/in", t_en)).toBe("Caretaker");
  });

  it("keeps the German wording when German is active", () => {
    expect(localizeTerm("Gebäudetechnik", t_de)).toBe("Gebäudetechnik");
    expect(localizeTerm("Reinigungskraft", t_de)).toBe("Reinigungskraft");
    expect(localizeTerm("Logistik & Event", t_de)).toBe("Logistik & Event");
  });

  it("falls back to the raw database value for unknown terms", () => {
    expect(localizeTerm("Sonderreinigung Nachtschicht", t_en)).toBe("Sonderreinigung Nachtschicht");
    expect(localizeTerm("Winterdienst", t_de)).toBe("Winterdienst");
  });

  it("renders the Kiel/Rendsburg job roles in English", () => {
    expect(localizeTerm("Logistikmitarbeiter/in", t_en)).toBe("Logistics Worker");
    expect(localizeTerm("Parkservice-Mitarbeiter/in", t_en)).toBe("Parking Attendant");
    expect(localizeTerm("Terminalmitarbeiter/in", t_en)).toBe("Terminal Staff");
    expect(localizeTerm("Servicetechniker/in", t_en)).toBe("Service Technician");
    expect(localizeTerm("Wartungstechniker/in", t_en)).toBe("Maintenance Technician");
  });

  it("keeps those roles in German when German is active", () => {
    for (const role of [
      "Logistikmitarbeiter/in",
      "Parkservice-Mitarbeiter/in",
      "Terminalmitarbeiter/in",
      "Servicetechniker/in",
      "Wartungstechniker/in",
    ]) {
      expect(localizeTerm(role, t_de)).toBe(role);
    }
  });

  it("never translates identities — companies, clients, sites, people, addresses", () => {
    const identities = [
      "Meridian Facility & Service GmbH",
      "GE-PACK Services",
      "GE-PACK Services – Werk Nord",
      "Klinikum Buch",
      "Lukas Brandt",
      "Chausseestraße 12, 10115 Berlin",
      "Treffpunkt Haupteingang. Arbeitskleidung erforderlich.",
    ];
    for (const value of identities) {
      expect(termKey(value)).toBeNull();
      expect(localizeTerm(value, t_en)).toBe(value);
      expect(localizeTerm(value, t_de)).toBe(value);
    }
  });

  it("falls back when the catalog has no entry for a mapped key", () => {
    expect(localizeTerm("Reinigung", (id) => id)).toBe("Reinigung");
  });

  it("survives a throwing translator", () => {
    expect(
      localizeTerm("Reinigung", () => {
        throw new Error("missing namespace");
      })
    ).toBe("Reinigung");
  });

  it("handles empty input", () => {
    expect(localizeTerm(null, t_en)).toBe("");
    expect(localizeTerm("", t_en)).toBe("");
  });
});

describe("demo worksite localization", () => {
  const SITES: Array<[string, string]> = [
    ["Zentrale Berlin-Mitte", "Berlin-Mitte Headquarters"],
    ["Bürocampus Adlershof", "Adlershof Office Campus"],
    ["Logistikpark Großbeeren", "Großbeeren Logistics Park"],
    ["Einkaufszentrum Spandau", "Spandau Shopping Center"],
    ["Klinikum Buch", "Buch Hospital"],
  ];

  it("renders all five demo sites in English", () => {
    for (const [de_name, en_name] of SITES) {
      expect(localizeSite(de_name, t_en)).toBe(en_name);
    }
  });

  it("renders all five demo sites in German", () => {
    for (const [de_name] of SITES) {
      expect(localizeSite(de_name, t_de)).toBe(de_name);
    }
  });

  it("keeps GE-PACK Services – Werk Nord identical in both languages", () => {
    const site = "GE-PACK Services – Werk Nord";
    expect(siteKey(site)).toBeNull();
    expect(localizeSite(site, t_en)).toBe(site);
    expect(localizeSite(site, t_de)).toBe(site);
    // and the bare client name too
    expect(localizeSite("GE-PACK Services", t_en)).toBe("GE-PACK Services");
  });

  it("keeps every Kiel/Rendsburg worksite and client name unchanged in both languages", () => {
    const identities = [
      "Ostseekai Cruise Terminal",
      "Schwedenkai",
      "Norwegenkai",
      "Ostuferhafen Cruise Terminal",
      "Kiel Hauptbahnhof",
      "Parkhaus ZOB",
      "Förde-Parkhaus",
      "Port Parking Kiel",
      "Airport Kiel-Holtenau – North Parking",
      "Airport Kiel-Holtenau – South Parking",
      "Hamdorf Meeting Point",
      "Windpark Hamdorf – Rendsburg-Eckernförde",
      // client names
      "Ostsee Terminal Services",
      "Fördeparken Kiel GmbH",
      "Kiel Port Logistics",
      "Bahnhofsservice Kiel",
      "Airport Services Kiel",
      "Eiderland Windservice",
    ];
    for (const value of identities) {
      expect(siteKey(value), value).toBeNull();
      expect(termKey(value), value).toBeNull();
      expect(localizeSite(value, t_en)).toBe(value);
      expect(localizeSite(value, t_de)).toBe(value);
      expect(localizeTerm(value, t_en)).toBe(value);
    }
  });

  it("leaves unknown tenant-created locations exactly as stored", () => {
    for (const custom of [
      "Werkstatt Süd",
      "Client HQ Tower 3",
      "Lager 7 / Rampe B",
      "Hotel Adlon Kempinski",
    ]) {
      expect(siteKey(custom)).toBeNull();
      expect(localizeSite(custom, t_en)).toBe(custom);
      expect(localizeSite(custom, t_de)).toBe(custom);
    }
  });

  it("falls back safely on empty input and a throwing translator", () => {
    expect(localizeSite(null, t_en)).toBe("");
    expect(localizeSite("Klinikum Buch", () => {
      throw new Error("no catalog");
    })).toBe("Klinikum Buch");
  });
});

describe("namespace isolation", () => {
  it("a site name is never resolved as a term", () => {
    for (const site of Object.keys(SITE_KEYS)) {
      expect(termKey(site)).toBeNull();
      expect(localizeTerm(site, t_en)).toBe(site);
    }
  });

  it("a department or role is never resolved as a site", () => {
    for (const term of Object.keys(TERM_KEYS)) {
      expect(siteKey(term)).toBeNull();
      expect(localizeSite(term, t_en)).toBe(term);
    }
  });

  it("role enums are not taxonomy or sites", () => {
    for (const role of ROLE_KEYS) {
      expect(termKey(role)).toBeNull();
      expect(siteKey(role)).toBeNull();
    }
  });

  it("the two maps share no source values", () => {
    const overlap = Object.keys(TERM_KEYS).filter((k) => k in SITE_KEYS);
    expect(overlap).toEqual([]);
  });
});

describe("system role localization", () => {
  it("renders English role labels", () => {
    expect(localizeRole("COMPANY_ADMIN", t_en)).toBe("Company Admin");
    expect(localizeRole("HR_MANAGER", t_en)).toBe("HR Manager");
    expect(localizeRole("DISPATCHER", t_en)).toBe("Dispatcher");
    expect(localizeRole("EMPLOYEE", t_en)).toBe("Employee");
    expect(localizeRole("APPLICANT", t_en)).toBe("Applicant");
    expect(localizeRole("SUPER_ADMIN", t_en)).toBe("Super Admin");
  });

  it("renders German role labels", () => {
    expect(localizeRole("COMPANY_ADMIN", t_de)).toBe("Unternehmensadministrator");
    expect(localizeRole("HR_MANAGER", t_de)).toBe("Personalleitung");
    expect(localizeRole("DISPATCHER", t_de)).toBe("Disposition");
    expect(localizeRole("EMPLOYEE", t_de)).toBe("Mitarbeiter/in");
    expect(localizeRole("APPLICANT", t_de)).toBe("Bewerber/in");
    expect(localizeRole("SUPER_ADMIN", t_de)).toBe("Super-Administrator");
  });

  it("passes through anything that is not a known enum value", () => {
    expect(localizeRole("REGIONAL_LEAD", t_en)).toBe("REGIONAL_LEAD");
    expect(roleKey("company_admin")).toBeNull(); // case-sensitive: enums are exact
    expect(localizeRole(null, t_en)).toBe("");
  });
});

describe("localization never touches data used for logic", () => {
  it("enum values are unchanged by localization — only labels differ", () => {
    for (const role of ROLE_KEYS) {
      const label = localizeRole(role, t_en);
      expect(roleKey(role)).toBe(role); // the raw enum survives round-trip
      expect(label).not.toBe(""); // and a label exists
    }
  });

  it("filter options localize the label but keep the database id as the value", async () => {
    const departments = [
      { id: "11111111-1111-1111-1111-111111111111", name: "Reinigung" },
      { id: "22222222-2222-2222-2222-222222222222", name: "Sonderdienst" },
    ];
    const options = departments.map((d) => ({
      value: d.id,
      label: localizeTerm(d.name, t_en),
    }));
    expect(options[0]).toEqual({
      value: "11111111-1111-1111-1111-111111111111",
      label: "Cleaning",
    });
    // unknown department: label falls back, id untouched
    expect(options[1]).toEqual({
      value: "22222222-2222-2222-2222-222222222222",
      label: "Sonderdienst",
    });
  });

  it("site filter options keep raw ids regardless of language", () => {
    const sites = [{ id: "abc-123", name: "Klinikum Buch" }];
    const de_options = sites.map((s) => ({ value: s.id, label: localizeSite(s.name, t_de) }));
    const en_options = sites.map((s) => ({ value: s.id, label: localizeSite(s.name, t_en) }));
    expect(de_options[0].value).toBe(en_options[0].value);
    expect(de_options[0].label).toBe("Klinikum Buch");
    expect(en_options[0].label).toBe("Buch Hospital");
  });

  it("localization is a pure display transform — inputs are never mutated", () => {
    const row = { name: "Klinikum Buch", id: "abc-123" };
    const snapshot = JSON.stringify(row);
    localizeSite(row.name, t_en);
    localizeTerm(row.name, t_en);
    localizeRole(row.name, t_en);
    expect(JSON.stringify(row)).toBe(snapshot);
  });
});

describe("catalog completeness", () => {
  const ns = (m: unknown, name: string) =>
    (m as Record<string, Record<string, string>>)[name];

  it.each([
    ["terms", [...new Set(Object.values(TERM_KEYS))]],
    ["sites", [...new Set(Object.values(SITE_KEYS))]],
    ["roles", [...ROLE_KEYS]],
  ] as Array<[string, string[]]>)("%s: every key exists in both catalogs", (name, keys) => {
    for (const key of keys) {
      expect(ns(de, name)[key], `de.${name}.${key}`).toBeTruthy();
      expect(ns(en, name)[key], `en.${name}.${key}`).toBeTruthy();
    }
  });

  it.each([
    ["terms", [...new Set(Object.values(TERM_KEYS))]],
    ["sites", [...new Set(Object.values(SITE_KEYS))]],
    ["roles", [...ROLE_KEYS]],
  ] as Array<[string, string[]]>)("%s: catalogs contain no unused keys", (name, keys) => {
    expect(Object.keys(ns(en, name)).sort()).toEqual([...keys].sort());
    expect(Object.keys(ns(de, name)).sort()).toEqual([...keys].sort());
  });

  it("German and English catalogs differ where they should", () => {
    const enSites = ns(en, "sites");
    const deSites = ns(de, "sites");
    for (const key of Object.keys(enSites)) {
      expect(enSites[key]).not.toBe(deSites[key]);
    }
  });
});
