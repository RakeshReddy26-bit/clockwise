/**
 * KSK-focused demo operations plan.
 *
 * The company name and core service categories mirror public KSK information.
 * Worksites are public transport/port locations. Shift scenarios are fictional
 * demo data for Clockwise and must not be presented as real KSK contracts.
 *
 * Pure data only: keeping this separate from the writer makes the scenario easy
 * to review, test and change without touching Supabase code.
 */

export type DemoWorksite = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusM: number;
  source: string;
};

export const KSK_COMPANY_NAME = "KSK Kai-Service-Kiel Ostufer GmbH — Demo";

export const WORKSITES: DemoWorksite[] = [
  {
    name: "KSK Ostuferhafen Base",
    address: "Ostuferhafen 15, 24149 Kiel",
    lat: 54.3342,
    lng: 10.1741,
    radiusM: 220,
    source: "ksk-kiel.de",
  },
  {
    name: "Ostseekai Cruise Terminal",
    address: "Ostseekai 1, 24105 Kiel",
    lat: 54.32585,
    lng: 10.14658,
    radiusM: 250,
    source: "portofkiel.com + OSM",
  },
  {
    name: "Schwedenkai",
    address: "Schwedenkai 1, 24103 Kiel",
    lat: 54.31921,
    lng: 10.13955,
    radiusM: 220,
    source: "portofkiel.com + OSM",
  },
  {
    name: "Norwegenkai",
    address: "Zur Fähre, 24143 Kiel",
    lat: 54.31656,
    lng: 10.1398,
    radiusM: 220,
    source: "portofkiel.com + OSM",
  },
  {
    name: "Ostuferhafen Terminal",
    address: "Grenzstraße, 24149 Kiel",
    lat: 54.33437,
    lng: 10.17439,
    radiusM: 400,
    source: "portofkiel.com + OSM",
  },
  {
    name: "Kiel Hauptbahnhof / Hafen Transfer",
    address: "Sophienblatt 25-27, 24114 Kiel",
    lat: 54.31347,
    lng: 10.13097,
    radiusM: 180,
    source: "DB/OSM reference point",
  },
  {
    name: "Port Parking Kiel",
    address: "Gablenzstraße, 24114 Kiel",
    lat: 54.30212,
    lng: 10.13044,
    radiusM: 180,
    source: "OSM reference point",
  },
  {
    name: "Kiel Airport Parking",
    address: "Boelckestraße 100, 24159 Kiel",
    lat: 54.3849,
    lng: 10.1425,
    radiusM: 220,
    source: "airport-kiel.de + OSM reference point",
  },
  {
    name: "Hamburg Airport P1",
    address: "Flughafenstraße, 22335 Hamburg",
    lat: 53.636207,
    lng: 10.007064,
    radiusM: 220,
    source: "Hamburg Airport / published P1 coordinates",
  },
];

export const DEPARTMENTS = [
  "Cruise & Passenger Services",
  "Mooring & Port Operations",
  "Luggage & Logistics",
  "Shuttle & Transport",
  "Parking Operations",
] as const;

export type DemoJob = {
  key: string;
  clientName: string;
  siteName: string;
  department: (typeof DEPARTMENTS)[number];
  description: string;
  instructions: string;
};

export const JOBS: DemoJob[] = [
  {
    key: "cruise-ostseekai",
    clientName: "Cruise Operations — Ostseekai",
    siteName: "Ostseekai Cruise Terminal",
    department: "Cruise & Passenger Services",
    description: "Demo turnaround operation: passenger flow, porter and luggage support.",
    instructions: "Check in with the dispatcher at the terminal entrance. Visible ID and safety vest required.",
  },
  {
    key: "ferry-schwedenkai",
    clientName: "Ferry Operations — Schwedenkai",
    siteName: "Schwedenkai",
    department: "Cruise & Passenger Services",
    description: "Demo passenger and terminal support for a ferry departure window.",
    instructions: "Meet at the passenger terminal service point 15 minutes before shift start.",
  },
  {
    key: "ferry-norwegenkai",
    clientName: "Ferry Operations — Norwegenkai",
    siteName: "Norwegenkai",
    department: "Luggage & Logistics",
    description: "Demo luggage, porter and passenger-support operation.",
    instructions: "Report at the terminal entry. Gloves and safety shoes required for luggage work.",
  },
  {
    key: "mooring-ostufer",
    clientName: "Mooring Operations — Ostuferhafen",
    siteName: "Ostuferhafen Terminal",
    department: "Mooring & Port Operations",
    description: "Demo mooring/unmooring crew deployment.",
    instructions: "Meet at the KSK base before deployment. PPE and radio check are mandatory.",
  },
  {
    key: "transfer-hbf",
    clientName: "Passenger Transfer — Kiel Hbf",
    siteName: "Kiel Hauptbahnhof / Hafen Transfer",
    department: "Shuttle & Transport",
    description: "Demo guest transfer and shuttle coordination between station and port.",
    instructions: "Meet at the agreed pickup point. Confirm vehicle and passenger list before departure.",
  },
  {
    key: "parking-kiel",
    clientName: "Parking Operations — Kiel",
    siteName: "Port Parking Kiel",
    department: "Parking Operations",
    description: "Demo parking-area staffing and guest guidance.",
    instructions: "Check in at the parking office and carry the site phone during the shift.",
  },
  {
    key: "airport-kiel",
    clientName: "Parking Operations — Kiel Airport",
    siteName: "Kiel Airport Parking",
    department: "Parking Operations",
    description: "Demo parking and shuttle-support operation at Kiel Airport.",
    instructions: "Meet at the marked parking entrance. Confirm shuttle handover with dispatch.",
  },
  {
    key: "airport-hamburg",
    clientName: "Parking Operations — Hamburg Airport",
    siteName: "Hamburg Airport P1",
    department: "Parking Operations",
    description: "Fictional demo deployment for remote parking support in Hamburg.",
    instructions: "Meet at P1. This is a Clockwise demo scenario, not a claimed KSK customer contract.",
  },
];

export type DemoShift = {
  jobKey: string;
  dayOffset: number;
  startHour: number;
  endHour: number;
  requiredCount: number;
  role: string;
  /** Employee indexes. Fewer indexes than requiredCount deliberately creates a staffing gap. */
  crew: number[];
  scenario: "staffed" | "understaffed" | "replacement" | "open";
};

export const SHIFTS: DemoShift[] = [
  { jobKey: "cruise-ostseekai", dayOffset: 0, startHour: 15, endHour: 23, requiredCount: 6, role: "Passenger Service", crew: [0, 1, 2, 3, 4], scenario: "understaffed" },
  { jobKey: "mooring-ostufer", dayOffset: 0, startHour: 16, endHour: 20, requiredCount: 3, role: "Mooring Crew", crew: [5, 6, 7], scenario: "staffed" },
  { jobKey: "parking-kiel", dayOffset: 0, startHour: 17, endHour: 23, requiredCount: 2, role: "Parking Service", crew: [8, 9], scenario: "staffed" },

  { jobKey: "cruise-ostseekai", dayOffset: 1, startHour: 5, endHour: 13, requiredCount: 8, role: "Luggage & Porter Service", crew: [0, 1, 2, 3, 4, 10, 11], scenario: "replacement" },
  { jobKey: "ferry-schwedenkai", dayOffset: 1, startHour: 7, endHour: 15, requiredCount: 4, role: "Passenger Service", crew: [12, 13, 14, 15], scenario: "staffed" },
  { jobKey: "transfer-hbf", dayOffset: 1, startHour: 8, endHour: 14, requiredCount: 3, role: "Shuttle Coordinator", crew: [16, 17, 18], scenario: "staffed" },
  { jobKey: "airport-hamburg", dayOffset: 1, startHour: 10, endHour: 18, requiredCount: 2, role: "Parking Service", crew: [], scenario: "open" },

  { jobKey: "ferry-norwegenkai", dayOffset: 2, startHour: 6, endHour: 14, requiredCount: 5, role: "Luggage Service", crew: [5, 6, 7, 8, 9], scenario: "staffed" },
  { jobKey: "mooring-ostufer", dayOffset: 2, startHour: 14, endHour: 18, requiredCount: 3, role: "Mooring Crew", crew: [10, 11], scenario: "understaffed" },
  { jobKey: "airport-kiel", dayOffset: 2, startHour: 6, endHour: 14, requiredCount: 2, role: "Parking Service", crew: [19, 20], scenario: "staffed" },

  { jobKey: "ferry-schwedenkai", dayOffset: 3, startHour: 20, endHour: 28, requiredCount: 4, role: "Terminal Service", crew: [12, 13, 14], scenario: "understaffed" },
  { jobKey: "parking-kiel", dayOffset: 3, startHour: 7, endHour: 15, requiredCount: 2, role: "Parking Service", crew: [21, 22], scenario: "staffed" },
];

export const EMPLOYEE_COUNT = 24;

/** Absolute hours from today at 00:00, including overnight shifts. */
export function shiftWindow(shift: DemoShift): { start: number; end: number } {
  return {
    start: shift.dayOffset * 24 + shift.startHour,
    end: shift.dayOffset * 24 + shift.endHour,
  };
}
