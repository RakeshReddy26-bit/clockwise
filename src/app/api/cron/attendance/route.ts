import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { evaluateAttendance } from "@/lib/attendance-runner";

/**
 * Scheduled attendance evaluation endpoint.
 * Intended caller: a Railway cron job hitting this every ~5 minutes with
 *   Authorization: Bearer $CRON_SECRET
 * The evaluation itself is idempotent, so extra or repeated calls are safe.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await evaluateAttendance(createAdminClient());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("attendance evaluation failed:", e);
    return NextResponse.json({ ok: false, error: "evaluation_failed" }, { status: 500 });
  }
}

export const GET = POST;
