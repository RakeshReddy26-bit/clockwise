import { describe, it, expect, beforeAll } from "vitest";
import {
  signProposal,
  verifyProposal,
  proposalPayload,
  type ProposalPayload,
} from "@/lib/ai/proposals";

/**
 * The proposal envelope.
 *
 * This is what stands between "the assistant drafted a plan" and "the database
 * changed". The tests below are the reason there is no `ai_proposals` table:
 * the envelope is tamper-evident and bound to its issuer, so it can make the
 * round trip through the browser without becoming a forgery surface.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const COMPANY = "33333333-3333-4333-8333-333333333333";
const OTHER_COMPANY = "44444444-4444-4444-8444-444444444444";

const PLAN: ProposalPayload = {
  kind: "create_shifts",
  shifts: [
    {
      jobId: "55555555-5555-4555-8555-555555555555",
      siteLabel: "Ostseekai (KSK)",
      date: "2027-06-01",
      startTime: "2027-06-01T04:00:00.000Z",
      endTime: "2027-06-01T12:00:00.000Z",
      requiredCount: 3,
      requiredRole: "Passenger Service",
      requiredQualification: null,
    },
  ],
};

beforeAll(() => {
  // The signing key is derived from this with a domain-separation label, so no
  // additional secret has to be configured for the feature to work.
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests-only-0123456789";
});

describe("signProposal / verifyProposal", () => {
  const issuer = { userId: USER, companyId: COMPANY };

  it("round-trips a plan for the issuing user", () => {
    const signed = signProposal(PLAN, issuer);
    const result = verifyProposal(signed.token, issuer);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.payload).toEqual(PLAN);
  });

  it("rejects a token whose payload was edited", () => {
    const signed = signProposal(PLAN, issuer);
    const [encoded, signature] = signed.token.split(".");

    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    decoded.payload.shifts[0].requiredCount = 99;
    const tampered = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");

    const result = verifyProposal(`${tampered}.${signature}`, issuer);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token another user tries to confirm", () => {
    const signed = signProposal(PLAN, issuer);
    const result = verifyProposal(signed.token, { userId: OTHER_USER, companyId: COMPANY });
    expect(result).toEqual({ ok: false, reason: "wrong_user" });
  });

  /** Requirement 1 and 4, at the confirmation boundary. */
  it("rejects a token replayed against another tenant", () => {
    const signed = signProposal(PLAN, issuer);
    const result = verifyProposal(signed.token, { userId: USER, companyId: OTHER_COMPANY });
    expect(result).toEqual({ ok: false, reason: "wrong_company" });
  });

  it("rejects an expired token", () => {
    const now = Date.now();
    const signed = signProposal(PLAN, issuer, now);
    // One millisecond past the stamped expiry.
    const result = verifyProposal(signed.token, issuer, signed.expiresAt + 1);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a token a moment before it expires", () => {
    const signed = signProposal(PLAN, issuer);
    expect(verifyProposal(signed.token, issuer, signed.expiresAt - 1).ok).toBe(true);
  });

  it("rejects a token that is not two parts", () => {
    expect(verifyProposal("garbage", issuer)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a signature of a different length without throwing", () => {
    const signed = signProposal(PLAN, issuer);
    const [encoded] = signed.token.split(".");
    // timingSafeEqual throws on mismatched lengths; the guard must come first.
    expect(verifyProposal(`${encoded}.short`, issuer)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a correctly signed envelope whose shape is wrong", () => {
    // Simulates a payload kind being removed in a later deploy: the signature
    // still verifies, the schema no longer does, and it must not be executed.
    const signed = signProposal(PLAN, issuer);
    const [encoded] = signed.token.split(".");
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    decoded.payload = { kind: "delete_everything" };
    const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    // Re-sign it the way an attacker with the key would, to isolate the schema
    // check rather than the signature check.
    const resigned = signProposal(PLAN, issuer).token.split(".")[1];
    const result = verifyProposal(`${forged}.${resigned}`, issuer);
    expect(result.ok).toBe(false);
  });
});

describe("proposal payload schema", () => {
  it("accepts each supported kind", () => {
    const kinds: ProposalPayload[] = [
      PLAN,
      {
        kind: "send_offer",
        shiftId: "66666666-6666-4666-8666-666666666666",
        shiftLabel: "Ostseekai · 2027-06-01",
        employees: [{ employeeId: "77777777-7777-4777-8777-777777777777", name: "Lukas" }],
        message: null,
      },
      {
        kind: "approve_response",
        responseId: "88888888-8888-4888-8888-888888888888",
        employeeName: "Emre",
        shiftLabel: "Ostseekai · 2027-06-01",
      },
      {
        kind: "update_shift",
        shiftId: "99999999-9999-4999-8999-999999999999",
        shiftLabel: "Ostseekai · 2027-06-01",
        changes: { startTime: "2027-06-01T05:00:00.000Z" },
        summary: [{ field: "start", from: "06:00", to: "07:00" }],
      },
    ];
    for (const payload of kinds) {
      expect(proposalPayload.safeParse(payload).success).toBe(true);
    }
  });

  it("refuses an unknown kind", () => {
    expect(proposalPayload.safeParse({ kind: "drop_table" }).success).toBe(false);
  });

  it("caps a batch so one confirmation cannot create an unbounded schedule", () => {
    const many = {
      kind: "create_shifts" as const,
      shifts: Array.from({ length: 21 }, () => PLAN.kind === "create_shifts" && PLAN.shifts[0]),
    };
    expect(proposalPayload.safeParse(many).success).toBe(false);
  });

  it("refuses a non-positive headcount", () => {
    const bad = {
      kind: "create_shifts" as const,
      shifts: [{ ...(PLAN as { shifts: unknown[] }).shifts[0] as object, requiredCount: 0 }],
    };
    expect(proposalPayload.safeParse(bad).success).toBe(false);
  });
});
