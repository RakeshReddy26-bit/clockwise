import { z } from "zod";

/**
 * Public environment, validated once.
 *
 * This module is bundled for the browser — `publicEnv()` is imported by the
 * Supabase browser client and the realtime refresher — so nothing secret may be
 * mentioned here, not even as a schema key. The server half lives in
 * env-server.ts behind the "server-only" guard; see the note there for why the
 * two were split.
 *
 * Nothing secret ever uses the NEXT_PUBLIC_ prefix.
 */

export const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  /**
   * Where an invitation email sends the recipient back to. Optional so local
   * development and the test suites keep working without it; the invite action
   * refuses rather than sending a link to the wrong origin when it is absent.
   */
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
});

export function publicEnv() {
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  });
}
