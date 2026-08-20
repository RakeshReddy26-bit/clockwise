import { z } from "zod";
import { AuthzError } from "@/lib/authz";

/**
 * Zod foundation. Every Server Action validates its input with a schema
 * before touching the database. validatedAction() gives a uniform
 * parse → authorize → execute shape and a typed error envelope.
 */

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const nonEmpty = z.string().trim().min(1).max(2000);
export const locale = z.enum(["de", "en"]);

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };

export function validatedAction<S extends z.ZodTypeAny, R>(
  schema: S,
  handler: (input: z.infer<S>) => Promise<R>
): (raw: unknown) => Promise<ActionResult<R>> {
  return async (raw: unknown) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_input",
        error: parsed.error.issues.map((i) => i.message).join("; "),
      };
    }
    try {
      return { ok: true, data: await handler(parsed.data) };
    } catch (e) {
      if (e instanceof AuthzError) {
        return { ok: false, code: e.code, error: e.message };
      }
      throw e;
    }
  };
}
