import { ApplicationInputSchema } from '@jat/shared';
import type { Db } from '../db/types';
import {
  createApplication,
  deleteApplication,
  getApplication,
  updateApplication,
  type Owner,
} from '../repo/applications';
import {
  getItem,
  takeItem,
  updateItem,
  type ImportItem,
  type ItemFields,
  type Outcome,
} from '../repo/imports';
import { importedDateApplied, UNKNOWN_ROLE } from './run';

export type ActionResult =
  | { kind: 'done'; item: ImportItem }
  | { kind: 'not_found' }
  /** The item cannot take this action now; `reason` says why, for the user. */
  | { kind: 'conflict'; reason: string };

/**
 * Takes the item (only from one of `from`), runs `work`, and stores its fields.
 * If `work` declines or throws, the item goes back to its previous outcome.
 */
async function withItem(
  db: Db,
  owner: Owner,
  itemId: string,
  from: readonly Outcome[],
  work: (item: ImportItem) => Promise<ItemFields | { conflict: string }>,
): Promise<ActionResult> {
  const item = await takeItem(db, owner.userId, itemId, from);
  if (!item) {
    const existing = await getItem(db, owner.userId, itemId);
    if (!existing) return { kind: 'not_found' };
    return { kind: 'conflict', reason: 'This can no longer be done for this email' };
  }
  let fields: ItemFields | { conflict: string };
  try {
    fields = await work(item);
  } catch (error) {
    await updateItem(db, owner.userId, item.id, { outcome: item.outcome });
    throw error;
  }
  if ('conflict' in fields) {
    await updateItem(db, owner.userId, item.id, { outcome: item.outcome });
    return { kind: 'conflict', reason: fields.conflict };
  }
  await updateItem(db, owner.userId, item.id, fields);
  const saved = await getItem(db, owner.userId, item.id);
  return saved ? { kind: 'done', item: saved } : { kind: 'not_found' };
}

const EDITED = 'The application was changed after the import, so it was left as it is';

/** Reverses what the import did, as long as nobody has edited the application since. */
export function undoItem(db: Db, owner: Owner, itemId: string, now: Date) {
  return withItem(db, owner, itemId, ['created', 'status_changed'], async (item) => {
    const app = item.applicationId
      ? await getApplication(db, owner.userId, item.applicationId)
      : null;
    // Already deleted by hand: nothing left to undo.
    if (!app) return { outcome: 'undone' };
    if (app.record.version !== item.appliedVersion) return { conflict: EDITED };

    if (item.outcome === 'created') {
      await deleteApplication(db, owner.userId, app.record.id);
      return { outcome: 'undone' };
    }
    if (!item.fromStatus) return { conflict: 'Nothing to undo' };
    const reverted = await updateApplication(
      db,
      owner,
      app.record.id,
      app.record.version,
      { status: item.fromStatus, dateApplied: item.previousDateApplied },
      now,
    );
    if (reverted.kind !== 'updated') return { conflict: EDITED };
    return { outcome: 'undone' };
  });
}

/** Makes the change a review item proposed: on its matched application, or as a new one. */
export function applyItem(db: Db, owner: Owner, itemId: string, now: Date) {
  return withItem(db, owner, itemId, ['needs_review'], async (item) => {
    const target = item.proposedStatus;
    if (!target) return { conflict: 'There is no change to apply for this email' };

    const app = item.applicationId
      ? await getApplication(db, owner.userId, item.applicationId)
      : null;
    if (app) {
      const updated = await updateApplication(
        db,
        owner,
        app.record.id,
        app.record.version,
        {
          status: target,
          dateApplied: importedDateApplied(
            app.record.status,
            target,
            app.record.dateApplied,
            item.emailDate,
            owner.timeZone,
          ),
        },
        now,
      );
      if (updated.kind === 'unchanged') return { conflict: `It is already ${target}` };
      if (updated.kind !== 'updated') return { conflict: 'It could not be updated' };
      return {
        outcome: 'status_changed',
        fromStatus: app.record.status,
        toStatus: target,
        previousDateApplied: app.record.dateApplied,
        appliedVersion: updated.value.record.version,
      };
    }

    const input = ApplicationInputSchema.safeParse({
      company: item.company ?? '',
      role: item.role ?? UNKNOWN_ROLE,
      status: target,
      dateApplied: importedDateApplied(null, target, null, item.emailDate, owner.timeZone) ?? null,
      source: 'Other',
      notes: item.summary ? `Added from Gmail: ${item.summary}` : '',
    });
    if (!input.success) return { conflict: 'The email does not name a company' };
    const created = await createApplication(db, owner, input.data, now);
    if (created.kind === 'limit_reached') return { conflict: 'Application limit reached' };
    return {
      outcome: 'created',
      applicationId: created.value.record.id,
      toStatus: created.value.record.status,
      appliedVersion: created.value.record.version,
    };
  });
}

export function dismissItem(db: Db, owner: Owner, itemId: string) {
  return withItem(db, owner, itemId, ['needs_review'], () =>
    Promise.resolve({ outcome: 'dismissed' as const }),
  );
}
