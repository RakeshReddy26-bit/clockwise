/**
 * Shared setup for the database suites.
 *
 * Each suite builds a scratch database, applies the Supabase shim and every
 * migration in order, then loads the fixtures. Migrations are read from disk
 * rather than listed per file — the lists had already drifted, and a suite
 * silently missing a migration is a bug that looks like a schema error.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const ADMIN_URL =
  process.env.TEST_DB_ADMIN_URL ??
  "postgres://clockwise_owner:clockwise@localhost:5432/postgres";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

export type QueryFn = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;

function sqlFile(...relative: string[]): string {
  return readFileSync(join(__dirname, ...relative), "utf8");
}

/** Every migration, in filename order (0001, 0002, …). */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * Drop and recreate `name`, then apply shim + migrations + fixtures.
 * The caller owns the returned client and must end() it.
 */
export async function createTestDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const db = new Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, `/${name}`) });
  await db.connect();
  await db.query(sqlFile("00-supabase-shim.sql"));
  for (const file of migrationFiles()) {
    await db.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  await db.query(sqlFile("01-test-fixtures.sql"));

  // 0012 makes jobs, shifts and shift_assignments undeletable for every
  // caller, including the owner connection this helper returns. Fixture
  // teardown between tests is exactly the deliberate maintenance the escape
  // hatch is for, so it is set once here rather than scattered through the
  // suites. Tests that assert the guard open their own connections, which do
  // not inherit this.
  await db.query("set app.allow_history_delete = 'on'");
  return db;
}

/**
 * Run `fn` as `userId` with RLS applied — the same way PostgREST executes a
 * request: role `authenticated` plus the JWT claims. Rolls back by default so
 * suites stay independent; pass commit when later assertions need the writes.
 */
export async function runAs<T>(
  db: Client,
  userId: string,
  fn: (q: QueryFn) => Promise<T>,
  { commit = false }: { commit?: boolean } = {}
): Promise<T> {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    // The connection-level maintenance flag set in createTestDatabase is for
    // fixture teardown only. Turn it off inside every simulated request, so a
    // test running as a real role always meets the same delete guard that
    // production does.
    await db.query("set local app.allow_history_delete = 'off'");
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const result = await fn((text, params) => db.query(text, params as never));
    await db.query(commit ? "commit" : "rollback");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

/**
 * Put a company's employees back to a schedulable state between scenarios.
 *
 * Runs as the company admin rather than on the owner connection, because
 * guard_employee_self_mutation (0016) exempts HR and nobody else — and the
 * owner connection carries no membership, so it is not HR. That is the guard
 * working: employment data has exactly one owner, and "the test harness" is not
 * it. Fixture setup goes through a real role like everything else.
 */
export async function setEmploymentStatus(
  db: Client,
  companyId: string,
  status: "active" | "probation" | "on_leave" | "terminated" = "active"
): Promise<void> {
  await runAs(
    db,
    companyId === COMPANY_B ? USERS.bAdmin : USERS.aAdmin,
    (q) =>
      q("update public.employees set employment_status = $2 where company_id = $1", [
        companyId,
        status,
      ]),
    { commit: true }
  );
}

/** Fixture identifiers shared by the database suites. */
export const USERS = {
  aAdmin: "aaaaaaaa-0000-0000-0000-000000000001",
  aDispatcher: "aaaaaaaa-0000-0000-0000-000000000002",
  aWorker: "aaaaaaaa-0000-0000-0000-000000000003",
  bAdmin: "bbbbbbbb-0000-0000-0000-000000000001",
  bWorker: "bbbbbbbb-0000-0000-0000-000000000003",
} as const;

export const COMPANY_A = "11111111-0000-0000-0000-000000000000";
export const COMPANY_B = "22222222-0000-0000-0000-000000000000";

export const EMPLOYEES = {
  aSelf: "aaaa1111-0000-0000-0000-000000000001",
  aColleague: "aaaa1111-0000-0000-0000-000000000002",
  b: "bbbb1111-0000-0000-0000-000000000001",
} as const;

export const A_ASSIGNMENT = "aaaa4444-0000-0000-0000-000000000001";

export const OFFERS = {
  a: "aaaa6666-0000-0000-0000-000000000001",
  b: "bbbb6666-0000-0000-0000-000000000001",
} as const;

export const OFFER_RESPONSES = {
  aSelf: "aaaa7777-0000-0000-0000-000000000001",
  aColleague: "aaaa7777-0000-0000-0000-000000000002",
  b: "bbbb7777-0000-0000-0000-000000000001",
} as const;
