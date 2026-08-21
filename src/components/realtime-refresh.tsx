"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Subscribes to the operational tables that change the dashboard and calls
 * router.refresh() (debounced) so Server Components re-render with fresh data.
 * Used only where live updates carry real operational value.
 */
export function RealtimeRefresh({
  companyId,
  tables = ["time_entries", "attendance_alerts", "shift_assignments"],
}: {
  companyId: string;
  tables?: string[];
}) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`ops:${companyId}`);

    const scheduleRefresh = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 800);
    };

    for (const table of tables) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `company_id=eq.${companyId}` },
        scheduleRefresh
      );
    }

    channel.subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [companyId, router, tables]);

  return null;
}
