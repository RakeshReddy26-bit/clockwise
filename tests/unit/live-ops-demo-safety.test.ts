import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Safety properties of the demo writer.
 *
 * This is the one script in the repository that writes bulk operational rows
 * with a service-role key, so the interesting question is not what it creates
 * but what it refuses to touch. Asserted against the source, because these are
 * properties of the code's shape — a behavioural test would need a database and
 * would still not notice a second, unguarded query being added later.
 */

const SOURCE = readFileSync("scripts/ksk-live-demo.ts", "utf8");

describe("it cannot touch a tenant it was not pointed at", () => {
  it("resolves exactly one company by an explicit allow-list of demo names", () => {
    expect(SOURCE).toContain("const COMPANY_NAMES");
    expect(SOURCE).toContain('.in("name", COMPANY_NAMES)');
    // Ambiguity and absence both abort rather than picking one.
    expect(SOURCE).toContain("Demo company not found");
    expect(SOURCE).toContain("Demo company is ambiguous");
  });

  it("scopes every write to that company", () => {
    // Each insert carries company_id; each lookup filters on it.
    const inserts = SOURCE.match(/\.insert\(\{[\s\S]*?\}\)/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    for (const insert of inserts) {
      expect(insert).toContain("company_id");
    }
  });

  it("filters its own previous output by company AND by its demo tag", () => {
    const start = SOURCE.indexOf("async function retirePreviousRun(");
    const body = SOURCE.slice(start, SOURCE.indexOf("\n}", start));
    expect(body).toContain('.eq("company_id", companyId)');
    expect(body).toContain('.in("contact_person", [...PRESENTATION_DEMO_CONTACTS])');
  });

  it("never deletes anything", () => {
    expect(SOURCE).not.toContain(".delete(");
    // Retiring is a status change, which is also what a real cancellation is.
    expect(SOURCE).toContain('status: "cancelled"');
  });

  it("refuses to run without an explicit confirmation flag", () => {
    expect(SOURCE).toContain('process.argv.includes("--confirm")');
    expect(SOURCE).toContain("process.exit(1)");
  });
});

describe("the data it writes is visibly synthetic", () => {
  it("tags every shift it creates", () => {
    expect(SOURCE).toContain('const DEMO_TAG = "LIVE-OPS DEMO"');
    expect(SOURCE).toContain("contact_person: CONTACT_PERSON");
    expect(SOURCE).toContain("instructions: `${DEMO_TAG}");
  });

  it("says in the row itself that it is not a real customer job", () => {
    expect(SOURCE).toMatch(/kein realer Kundenauftrag/);
  });
});

describe("it does not reimplement business logic", () => {
  it("takes attendance thresholds from the shared engine", () => {
    expect(SOURCE).toContain('from "../src/lib/attendance"');
    expect(SOURCE).toContain("attendanceThresholds(company.settings)");
  });

  it("derives alerts from the engine rather than asserting them", () => {
    const start = SOURCE.indexOf("async function writeAlerts(");
    const body = SOURCE.slice(start, SOURCE.indexOf("\nasync function main", start));
    expect(body).toContain("statusFor(");
    // Only the two states the engine can actually be in produce an alert.
    expect(body).toContain('status !== "late" && status !== "no_show"');
  });

  it("leaves the calendar date derivation to the database", () => {
    // 0011 derives shifts.date in Europe/Berlin; the script must not fight it.
    expect(SOURCE).toMatch(/The DB derives `date` itself/);
  });

  it("takes the scenario from the unit-tested plan, not from inline literals", () => {
    expect(SOURCE).toContain('from "./live-ops-demo-plan"');
    expect(SOURCE).toContain("LIVE_OPS_SHIFTS");
    expect(SOURCE).toContain("expectedKpis");
  });
});

describe("it fails loudly rather than half-writing", () => {
  it("throws with context on every write it cannot complete", () => {
    for (const label of ["shift ${spec.key}", "assignment ${spec.key}", "time entry ${spec.key}"]) {
      expect(SOURCE).toContain(label);
    }
  });

  it("tells the operator what to run first when a prerequisite is missing", () => {
    expect(SOURCE).toContain("npm run add:kiel-demo");
    expect(SOURCE).toContain("npm run seed");
  });

  it("exits non-zero on failure", () => {
    expect(SOURCE).toMatch(/main\(\)\.catch\(/);
    expect(SOURCE).toContain("process.exit(1)");
  });
});
