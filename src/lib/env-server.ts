import "server-only";

import { z } from "zod";
import { publicSchema } from "@/lib/env";

/**
 * Server-only environment.
 *
 * Split out of env.ts for a concrete reason. `publicEnv()` is imported by
 * genuine client components (the Supabase browser client, the realtime
 * refresher), so env.ts ends up in a client chunk — and while a schema carries
 * no values, the string "SUPABASE_SERVICE_ROLE_KEY" was appearing in the
 * bundle as a Zod key name. Nothing was exposed, but a reviewer grepping the
 * build for that string found a hit, and a security check that cries wolf is
 * one people learn to ignore.
 *
 * Keeping the server schema behind the "server-only" guard means the name
 * cannot reach a browser bundle at all: importing this from a client component
 * fails the build.
 */

const serverSchema = publicSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
});

export function serverEnv() {
  return serverSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
}
