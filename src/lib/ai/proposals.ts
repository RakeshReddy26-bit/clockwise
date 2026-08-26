import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * A proposal is a plan the assistant made that nobody has agreed to yet.
 *
 * It has to survive the round trip to the browser and back — the manager reads
 * it, then clicks Confirm — without becoming something the browser can forge.
 * Two mechanisms, and it matters which one is load-bearing:
 *
 *   1. The envelope is HMAC-signed and bound to the issuing user, company and
 *      an expiry. A tampered or replayed envelope is rejected outright.
 *   2. On execute, the server re-resolves every id, re-checks the permission
 *      and re-runs validation from scratch.
 *
 * (2) is the security boundary. (1) is defence in depth, and the reason there
 * is no `ai_proposals` table: nothing here needs to be persisted, so this
 * feature ships with no migration. The signature stops a confirmed proposal
 * from being edited in flight; it is not what makes the write safe.
 *
 * The signing key is derived from an existing server secret with a domain
 * separation label, so deployments need no additional environment variable and
 * the label makes it impossible for a signature to be valid anywhere else.
 */

const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const HMAC_LABEL = "clockwise.ai.proposal.v1";

/* ------------------------------------------------------------------ */
/* Payloads                                                            */
/* ------------------------------------------------------------------ */

/**
 * One shift to create. Times are already resolved to UTC instants by the
 * server — the model proposes wall-clock, the server converts, and only the
 * converted value is signed.
 */
export const createShiftsPayload = z.object({
  kind: z.literal("create_shifts"),
  shifts: z
    .array(
      z.object({
        jobId: z.string().uuid(),
        siteLabel: z.string(),
        date: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        requiredCount: z.number().int().min(1).max(200),
        requiredRole: z.string().nullable(),
        requiredQualification: z.string().nullable(),
      })
    )
    .min(1)
    .max(20),
});

export const sendOfferPayload = z.object({
  kind: z.literal("send_offer"),
  shiftId: z.string().uuid(),
  shiftLabel: z.string(),
  employees: z
    .array(z.object({ employeeId: z.string().uuid(), name: z.string() }))
    .min(1)
    .max(20),
  message: z.string().max(500).nullable(),
});

export const assignmentPayload = z.object({
  kind: z.literal("approve_response"),
  responseId: z.string().uuid(),
  employeeName: z.string(),
  shiftLabel: z.string(),
});

export const shiftUpdatePayload = z.object({
  kind: z.literal("update_shift"),
  shiftId: z.string().uuid(),
  shiftLabel: z.string(),
  changes: z.object({
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    requiredCount: z.number().int().min(1).max(200).optional(),
  }),
  /** Human-readable before → after, for the confirmation card. */
  summary: z.array(z.object({ field: z.string(), from: z.string(), to: z.string() })),
});

export const proposalPayload = z.discriminatedUnion("kind", [
  createShiftsPayload,
  sendOfferPayload,
  assignmentPayload,
  shiftUpdatePayload,
]);

export type ProposalPayload = z.infer<typeof proposalPayload>;
export type ProposalKind = ProposalPayload["kind"];

const envelope = z.object({
  /** Bound so a proposal issued for one person cannot be confirmed by another. */
  userId: z.string().uuid(),
  companyId: z.string().uuid(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  payload: proposalPayload,
});

export type ProposalEnvelope = z.infer<typeof envelope>;

/** What the UI receives: the readable plan plus the token that authorises it. */
export type SignedProposal = {
  token: string;
  payload: ProposalPayload;
  expiresAt: number;
};

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

function signingKey(): Buffer {
  const material = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!material) {
    // Refusing is correct: an unsigned proposal would be a browser-forgeable
    // instruction to write to the database.
    throw new Error("proposal signing requires SUPABASE_SERVICE_ROLE_KEY");
  }
  return createHmac("sha256", material).update(HMAC_LABEL).digest();
}

function sign(body: string): string {
  return createHmac("sha256", signingKey()).update(body).digest("base64url");
}

export function signProposal(
  payload: ProposalPayload,
  issuer: { userId: string; companyId: string },
  now = Date.now()
): SignedProposal {
  const expiresAt = now + PROPOSAL_TTL_MS;
  const body = JSON.stringify({
    userId: issuer.userId,
    companyId: issuer.companyId,
    issuedAt: now,
    expiresAt,
    payload,
  } satisfies ProposalEnvelope);
  const encoded = Buffer.from(body, "utf8").toString("base64url");
  return { token: `${encoded}.${sign(encoded)}`, payload, expiresAt };
}

export type VerifyFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "wrong_user"
  | "wrong_company";

export type VerifyResult =
  | { ok: true; envelope: ProposalEnvelope }
  | { ok: false; reason: VerifyFailure };

/**
 * Verify a token against the caller resolved from the SESSION.
 *
 * `expected` must come from `resolveAiContext()`, never from the request body —
 * otherwise the binding proves nothing.
 */
export function verifyProposal(
  token: string,
  expected: { userId: string; companyId: string },
  now = Date.now()
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [encoded, signature] = parts;

  const expectedSignature = sign(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const result = envelope.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "malformed" };

  if (result.data.expiresAt <= now) return { ok: false, reason: "expired" };
  if (result.data.userId !== expected.userId) return { ok: false, reason: "wrong_user" };
  if (result.data.companyId !== expected.companyId) {
    return { ok: false, reason: "wrong_company" };
  }

  return { ok: true, envelope: result.data };
}
