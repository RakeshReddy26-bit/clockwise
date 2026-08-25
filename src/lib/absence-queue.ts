/**
 * Ordering for the absence decision queue.
 *
 * The manager page used to read pending and decided rows through ONE query
 * with one LIMIT, ordered by start_date. Historical decided rows sort first,
 * so with enough history a genuinely pending request fell outside the window
 * and the page rendered "no pending requests" while requests were waiting —
 * a decision queue silently reporting zero.
 *
 * The fix is at the query level: each state gets its own bounded query, so a
 * decided row can never consume a slot a pending row needed. This module holds
 * the small piece that is not expressible in a query — when two states share
 * one list, the ones that still need a decision come first.
 */

export type QueueRow = { status: string; start_date: string };

/**
 * Sort so that rows still awaiting a decision lead, then by date.
 *
 * `decidable` names the statuses that still need someone to act. Everything
 * else keeps its place behind them rather than being dropped: a confirmed sick
 * leave is still operationally relevant, it just is not a task.
 */
export function orderAbsenceQueue<T extends QueueRow>(
  rows: readonly T[],
  decidable: readonly string[]
): T[] {
  const needsDecision = (row: T) => (decidable.includes(row.status) ? 0 : 1);

  return [...rows].sort((a, b) => {
    const byState = needsDecision(a) - needsDecision(b);
    if (byState !== 0) return byState;
    // Within a group, soonest first — the absence starting tomorrow matters
    // more than the one starting next month.
    return a.start_date.localeCompare(b.start_date);
  });
}

/** How many rows in this list still need a decision. Drives the section count. */
export function countDecidable<T extends QueueRow>(
  rows: readonly T[],
  decidable: readonly string[]
): number {
  return rows.filter((r) => decidable.includes(r.status)).length;
}
