import type { Clock } from '../clock';
import { fixedClock } from '../clock';
import type { Queryable } from '../db/types';

/**
 * The clock for one user. Normal users share `base`. A synthetic test user may
 * have a row in `test_clocks` (set by the test-only route) that freezes their
 * time or shifts it, so follow-up behaviour can be tested without sleeping and
 * without touching anyone else's time.
 */
export async function userClock(db: Queryable, userId: string, base: Clock): Promise<Clock> {
  const result = await db.query<{ frozen_at: Date | null; offset_ms: string }>(
    'select frozen_at, offset_ms::text as offset_ms from test_clocks where user_id = $1',
    [userId],
  );
  const row = result.rows[0];
  if (!row) return base;
  if (row.frozen_at) return fixedClock(row.frozen_at);

  const offset = Number(row.offset_ms);
  if (!Number.isSafeInteger(offset)) return base;
  return { now: () => new Date(base.now().getTime() + offset) };
}
