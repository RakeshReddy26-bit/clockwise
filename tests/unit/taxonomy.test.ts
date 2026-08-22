import { describe, expect, it } from "vitest";
import { termKey, localizeTerm, TERM_KEYS } from "@/lib/taxonomy";
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

describe("catalog completeness", () => {
  const keys = [...new Set(Object.values(TERM_KEYS))];

  it("every term key exists in both catalogs", () => {
    const deTerms = (de as { terms: Record<string, string> }).terms;
    const enTerms = (en as { terms: Record<string, string> }).terms;
    for (const key of keys) {
      expect(deTerms[key], `de.terms.${key}`).toBeTruthy();
      expect(enTerms[key], `en.terms.${key}`).toBeTruthy();
    }
  });

  it("catalogs contain no keys the taxonomy does not use", () => {
    const enTerms = (en as { terms: Record<string, string> }).terms;
    expect(Object.keys(enTerms).sort()).toEqual([...keys].sort());
  });
});
