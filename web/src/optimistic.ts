import {
  CLOSED_STATUSES,
  type Application,
  type ApplicationList,
  type Pipeline,
  type Status,
} from '@jat/shared';
import type { ListFilters } from './api/hooks';

/**
 * Instant status moves: what the cached list and pipeline counts look like right after a move,
 * before the server answers. The server's answer (a refetch) always replaces these.
 *
 * A move is a real edit, so it resets the follow-up clock: the application no longer needs a
 * follow-up, and it becomes the most recently updated one.
 */
export function moveInList(
  list: ApplicationList,
  id: string,
  to: Status,
  filters: ListFilters,
  now: string,
): ApplicationList {
  const current = list.items.find((item) => item.id === id);
  if (!current || current.status === to) return list;

  const moved: Application = {
    ...current,
    status: to,
    isClosed: (CLOSED_STATUSES as readonly Status[]).includes(to),
    needsFollowUp: false,
    updatedAt: now,
    lastActivityAt: now,
  };
  const others = list.items.filter((item) => item.id !== id);
  // It no longer belongs in a list filtered to another stage, or to "needs follow-up".
  if ((filters.status && filters.status !== to) || filters.followUp === true) {
    return { items: others, total: list.total - 1 };
  }
  const sort = filters.sort ?? 'updated_desc';
  const items =
    sort === 'updated_desc'
      ? [moved, ...others]
      : list.items.map((item) => (item.id === id ? moved : item));
  return { items, total: list.total };
}

export function moveInPipeline(
  pipeline: Pipeline,
  from: Status,
  to: Status,
  neededFollowUp: boolean,
): Pipeline {
  if (from === to) return pipeline;
  return {
    ...pipeline,
    stages: pipeline.stages.map((stage) =>
      stage.status === from
        ? { ...stage, count: Math.max(0, stage.count - 1) }
        : stage.status === to
          ? { ...stage, count: stage.count + 1 }
          : stage,
    ),
    followUpCount: neededFollowUp
      ? Math.max(0, pipeline.followUpCount - 1)
      : pipeline.followUpCount,
  };
}
