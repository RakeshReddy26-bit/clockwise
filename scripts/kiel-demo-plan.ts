/**
 * Kiel / Rendsburg-Eckernförde demo dataset — pure data, no side effects.
 *
 * Kept separate from add-kiel-demo.ts so the plan can be unit-tested without
 * touching a database: see tests/unit/kiel-demo-plan.test.ts, which asserts the
 * shift/assignment invariants (no employee double-booked, wind-farm muster and
 * field work share a crew member).
 *
 * Worksite and client names are proper identities: absent from SITE_KEYS, they
 * render identically in German and English.
 */

export type Worksite = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusM: number;
  /** Where the coordinates came from — kept so they can be re-verified. */
  source: string;
};

export const WORKSITES: Worksite[] = [
  // Kiel — cruise and ferry terminals
  { name: "Ostseekai Cruise Terminal", address: "Ostseekai 27, 24103 Kiel", lat: 54.32585, lng: 10.14658, radiusM: 250, source: "OSM/Mapcarta" },
  { name: "Schwedenkai", address: "Schwedenkai 1, 24103 Kiel", lat: 54.31921, lng: 10.13955, radiusM: 200, source: "OSM/Mapcarta" },
  { name: "Norwegenkai", address: "Norwegenkai, 24143 Kiel", lat: 54.31656, lng: 10.1398, radiusM: 200, source: "OSM/Mapcarta" },
  { name: "Ostuferhafen Cruise Terminal", address: "Ostuferhafen, 24149 Kiel", lat: 54.33437, lng: 10.17439, radiusM: 400, source: "OSM/Mapcarta" },
  // Kiel — transport
  { name: "Kiel Hauptbahnhof", address: "Sophienblatt 24, 24103 Kiel", lat: 54.31347, lng: 10.13097, radiusM: 150, source: "OSM/Mapcarta" },
  // Kiel — parking
  { name: "Parkhaus ZOB", address: "Auguste-Viktoria-Straße, 24103 Kiel", lat: 54.31694, lng: 10.13349, radiusM: 100, source: "OSM/Mapcarta" },
  { name: "Förde-Parkhaus", address: "Andreas-Gayk-Straße, 24103 Kiel", lat: 54.32033, lng: 10.13789, radiusM: 100, source: "OSM/Mapcarta" },
  { name: "Port Parking Kiel", address: "Gablenzstraße, 24114 Kiel", lat: 54.30212, lng: 10.13044, radiusM: 150, source: "OSM/Mapcarta" },
  // Airport Kiel-Holtenau — the operator publishes access roads, not lot
  // polygons, so these are access reference points and the radius absorbs the
  // remaining uncertainty.
  { name: "Airport Kiel-Holtenau – North Parking", address: "Boelckestraße 100, 24159 Kiel", lat: 54.3849, lng: 10.1425, radiusM: 200, source: "airport-kiel.de + onlinestreet (Boelckestraße access)" },
  { name: "Airport Kiel-Holtenau – South Parking", address: "Eekbrook, 24159 Kiel", lat: 54.3747, lng: 10.1456, radiusM: 200, source: "airport-kiel.de + onlinestreet (Eekbrook access)" },
  // Rendsburg-Eckernförde — two-zone wind farm: a tight muster point feeding a
  // wide field zone, so a crew stays verified while moving between turbines.
  { name: "Hamdorf Meeting Point", address: "Hamdorf, 24805 Hamdorf", lat: 54.22522, lng: 9.51866, radiusM: 200, source: "OSM/Mapcarta (Hamdorf Ortsmitte)" },
  { name: "Windpark Hamdorf – Rendsburg-Eckernförde", address: "Windpark Hamdorf, 24805 Hamdorf", lat: 54.2407, lng: 9.5153, radiusM: 1500, source: "thewindpower.net (54°14′26.4″N, 9°30′55.1″E)" },
];

export type JobSpec = {
  clientName: string;
  siteName: string;
  description: string;
  /** Shown on the shift card; one line per client. */
  instructions: string;
};

export const JOBS: JobSpec[] = [
  {
    clientName: "Ostsee Terminal Services",
    siteName: "Ostseekai Cruise Terminal",
    description: "Terminalbetreuung und Reinigung an Anlauftagen.",
    instructions: "Anmeldung am Terminaleingang. Arbeitskleidung erforderlich.",
  },
  {
    clientName: "Fördeparken Kiel GmbH",
    siteName: "Parkhaus ZOB",
    description: "Parkservice an den Innenstadt-Parkhäusern.",
    instructions: "Schlüsselübergabe im Kassenbereich.",
  },
  {
    clientName: "Kiel Port Logistics",
    siteName: "Ostuferhafen Cruise Terminal",
    description: "Logistikunterstützung im Hafenbetrieb.",
    instructions: "Anmeldung am Hafentor. Sicherheitsschuhe erforderlich.",
  },
  {
    clientName: "Bahnhofsservice Kiel",
    siteName: "Kiel Hauptbahnhof",
    description: "Reinigung und Servicedienste am Hauptbahnhof.",
    instructions: "Treffpunkt Servicepoint Haupthalle.",
  },
  {
    clientName: "Airport Services Kiel",
    siteName: "Airport Kiel-Holtenau – North Parking",
    description: "Parkflächenbetreuung am Flughafen Kiel-Holtenau.",
    instructions: "Zufahrt über die ausgeschilderte Parkflächenzufahrt.",
  },
  {
    clientName: "Eiderland Windservice",
    siteName: "Windpark Hamdorf – Rendsburg-Eckernförde",
    description: "Wartungs- und Servicearbeiten im Windpark.",
    instructions: "Treffpunkt Sammelpunkt Hamdorf. Fahrgemeinschaft zur Anlage.",
  },
];

export type ShiftSpec = {
  clientName: string;
  siteName: string;
  /** Days from today. */
  dayOffset: number;
  /** Hours from midnight of `dayOffset`; values >= 24 run into the next day. */
  startHour: number;
  endHour: number;
  requiredCount: number;
  role: string;
  /**
   * Index into the demo employee pool, or null to leave the shift open for the
   * replacement workflow. Explicit rather than round-robin so the schedule can
   * be checked by eye and by test: no one is double-booked, and the wind-farm
   * muster and field shift deliberately share crew member 5.
   */
  crew: number | null;
};

export const SHIFTS: ShiftSpec[] = [
  // Cruise turnaround days
  { clientName: "Ostsee Terminal Services", siteName: "Ostseekai Cruise Terminal", dayOffset: 1, startHour: 6, endHour: 14, requiredCount: 3, role: "Terminalmitarbeiter/in", crew: 0 },
  { clientName: "Ostsee Terminal Services", siteName: "Ostseekai Cruise Terminal", dayOffset: 1, startHour: 14, endHour: 22, requiredCount: 2, role: "Reinigungskraft", crew: 1 },
  { clientName: "Ostsee Terminal Services", siteName: "Schwedenkai", dayOffset: 2, startHour: 7, endHour: 15, requiredCount: 2, role: "Servicekraft", crew: 2 },
  { clientName: "Ostsee Terminal Services", siteName: "Norwegenkai", dayOffset: 3, startHour: 12, endHour: 20, requiredCount: 2, role: "Terminalmitarbeiter/in", crew: null },
  // Parking
  { clientName: "Fördeparken Kiel GmbH", siteName: "Parkhaus ZOB", dayOffset: 1, startHour: 8, endHour: 16, requiredCount: 1, role: "Parkservice-Mitarbeiter/in", crew: 3 },
  { clientName: "Fördeparken Kiel GmbH", siteName: "Förde-Parkhaus", dayOffset: 2, startHour: 8, endHour: 16, requiredCount: 1, role: "Parkservice-Mitarbeiter/in", crew: 4 },
  { clientName: "Fördeparken Kiel GmbH", siteName: "Port Parking Kiel", dayOffset: 4, startHour: 6, endHour: 14, requiredCount: 1, role: "Parkservice-Mitarbeiter/in", crew: null },
  // Port logistics — the second shift runs overnight into the following day
  { clientName: "Kiel Port Logistics", siteName: "Ostuferhafen Cruise Terminal", dayOffset: 1, startHour: 5, endHour: 13, requiredCount: 2, role: "Logistikmitarbeiter/in", crew: 5 },
  { clientName: "Kiel Port Logistics", siteName: "Ostuferhafen Cruise Terminal", dayOffset: 2, startHour: 22, endHour: 30, requiredCount: 2, role: "Logistikmitarbeiter/in", crew: 6 },
  // Station
  { clientName: "Bahnhofsservice Kiel", siteName: "Kiel Hauptbahnhof", dayOffset: 1, startHour: 5, endHour: 11, requiredCount: 2, role: "Reinigungskraft", crew: 7 },
  { clientName: "Bahnhofsservice Kiel", siteName: "Kiel Hauptbahnhof", dayOffset: 3, startHour: 14, endHour: 21, requiredCount: 1, role: "Servicekraft", crew: 0 },
  // Airport parking
  { clientName: "Airport Services Kiel", siteName: "Airport Kiel-Holtenau – North Parking", dayOffset: 2, startHour: 6, endHour: 14, requiredCount: 1, role: "Parkservice-Mitarbeiter/in", crew: 1 },
  { clientName: "Airport Services Kiel", siteName: "Airport Kiel-Holtenau – South Parking", dayOffset: 3, startHour: 6, endHour: 14, requiredCount: 1, role: "Reinigungskraft", crew: null },
  // Wind farm: muster at the meeting point, then field work — same crew member,
  // back to back, both zones geofenced.
  { clientName: "Eiderland Windservice", siteName: "Hamdorf Meeting Point", dayOffset: 2, startHour: 6, endHour: 7, requiredCount: 2, role: "Vorarbeiter/in", crew: 5 },
  { clientName: "Eiderland Windservice", siteName: "Windpark Hamdorf – Rendsburg-Eckernförde", dayOffset: 2, startHour: 7, endHour: 16, requiredCount: 2, role: "Servicetechniker/in", crew: 5 },
  { clientName: "Eiderland Windservice", siteName: "Windpark Hamdorf – Rendsburg-Eckernförde", dayOffset: 4, startHour: 7, endHour: 16, requiredCount: 2, role: "Wartungstechniker/in", crew: 6 },
];

/** How many demo employees the plan expects; crew indexes stay below this. */
export const CREW_SIZE = 8;

/** Absolute hours from "today at 00:00", so overnight shifts stay comparable. */
export function shiftWindow(shift: ShiftSpec): { start: number; end: number } {
  return {
    start: shift.dayOffset * 24 + shift.startHour,
    end: shift.dayOffset * 24 + shift.endHour,
  };
}
