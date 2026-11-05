import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { CLOSED_STATUSES, STATUSES, type Application, type Status } from '@jat/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { FollowUpFlag } from './StatusBadge';
import { StatusMenu } from './StatusMenu';

interface Props {
  items: Application[];
  onMove: (application: Application, to: Status) => void;
}

/**
 * Keyboard dragging: each Left/Right arrow moves one stage in pipeline order (the default moves
 * a few pixels per press). Stages are counted, not measured, so it stays exact while the board
 * scrolls sideways on a phone. `aim` holds the stage aimed at; the drop goes there, because
 * dnd-kit works out what is under the card one render later.
 */
function oneColumnPerArrow(aim: {
  target: () => Status | null;
  set: (status: Status) => void;
}): KeyboardCoordinateGetter {
  return (event, { active, currentCoordinates, context }) => {
    const direction = event.code === 'ArrowRight' ? 1 : event.code === 'ArrowLeft' ? -1 : 0;
    if (!direction) return undefined;
    event.preventDefault();
    const startStatus = context.draggableNodes.get(active)?.data.current?.['status'] as
      Status | undefined;
    const from = aim.target() ?? startStatus;
    if (!from) return currentCoordinates;
    const next = STATUSES[STATUSES.indexOf(from) + direction];
    if (!next) return currentCoordinates;
    aim.set(next);
    // Draw the card over that column.
    const rect = context.droppableRects.get(next);
    const width = context.activeNode?.getBoundingClientRect().width ?? 0;
    return rect
      ? { x: rect.left + rect.width / 2 - width / 2, y: currentCoordinates.y }
      : currentCoordinates;
  };
}

const isClosed = (status: Status) => (CLOSED_STATUSES as readonly Status[]).includes(status);

/**
 * One column per stage; drag a card to another column to move it. Mouse drags start after a
 * small movement (so clicks still open the card), touch drags after a long press (so the board
 * still scrolls sideways), keyboard drags from the card's handle (Space, arrows, Space).
 * The "Move to" menu on every card does the same without dragging.
 */
export function BoardView({ items, onMove }: Props) {
  const [dragging, setDragging] = useState<Application | null>(null);
  // Where the last arrow key aimed, during a keyboard drag (null for mouse and touch drags).
  // Written only from key and drag events, never during render.
  const [keyboard] = useState(() => {
    let aimed: Status | null = null;
    const target = () => aimed;
    const set = (status: Status) => {
      aimed = status;
    };
    return {
      coordinateGetter: oneColumnPerArrow({ target, set }),
      target,
      reset: () => {
        aimed = null;
      },
    };
  });
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboard.coordinateGetter }),
  );
  const byId = new Map(items.map((item) => [item.id, item]));
  const nameOf = (id: string | number) => byId.get(String(id))?.company ?? 'Application';

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} is over ${String(over.id)}.`
        : `${nameOf(active.id)} is not over a stage.`,
    onDragEnd: ({ active, over }) => {
      const to = dropTarget(over);
      return to ? `${nameOf(active.id)} moved to ${to}.` : `${nameOf(active.id)} was not moved.`;
    },
    onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled.`,
  };

  /** The column a drag ends in: where the keys aimed, or what is under the pointer. */
  const dropTarget = (over: { id: string | number } | null): Status | undefined =>
    keyboard.target() ?? (over?.id as Status | undefined);

  const handleStart = ({ active }: DragStartEvent) => {
    keyboard.reset();
    setDragging(byId.get(String(active.id)) ?? null);
  };
  const handleEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    const application = byId.get(String(active.id));
    // Not cleared here: the end announcement reads it too. The next drag start clears it.
    const to = dropTarget(over);
    if (application && to && to !== application.status) onMove(application, to);
  };

  return (
    <DndContext
      sensors={sensors}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            'To move this application, press Space or Enter, use the left and right arrow keys to reach another stage, then press Space or Enter again. Press Escape to cancel.',
        },
      }}
      onDragStart={handleStart}
      onDragEnd={handleEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div
        role="region"
        aria-label="Board"
        className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-4"
      >
        {STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            items={items.filter((item) => item.status === status)}
            onMove={onMove}
          />
        ))}
      </div>
      <DragOverlay>{dragging && <CardBody application={dragging} preview />}</DragOverlay>
    </DndContext>
  );
}

function Column({
  status,
  items,
  onMove,
}: {
  status: Status;
  items: Application[];
  onMove: Props['onMove'];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const headingId = `column-${status}`;
  return (
    <section
      ref={setNodeRef}
      aria-labelledby={headingId}
      className={`flex w-64 shrink-0 snap-start flex-col lg:w-auto lg:min-w-40 lg:flex-1 lg:shrink gap-2 rounded-xl border p-2 ${
        isOver
          ? 'border-blue-600 bg-blue-50 dark:bg-blue-950'
          : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900'
      } ${isClosed(status) ? 'opacity-70' : ''}`}
    >
      <h2 id={headingId} className="flex items-center justify-between px-1 text-sm font-semibold">
        <span>{status}</span>
        <span className="tabular-nums text-slate-500 dark:text-slate-400">{items.length}</span>
      </h2>
      {items.length === 0 && (
        <p className="px-1 py-4 text-center text-xs text-slate-500 dark:text-slate-400">
          No applications
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {items.map((application) => (
          <DraggableCard key={application.id} application={application} onMove={onMove} />
        ))}
      </ul>
    </section>
  );
}

function DraggableCard({
  application,
  onMove,
}: {
  application: Application;
  onMove: Props['onMove'];
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: application.id,
    data: { status: application.status },
  });
  return (
    // Pointer-only shortcut: keyboard users drag from the handle or use the Move to menu.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <li
      ref={setNodeRef}
      // Mouse and touch start a drag from anywhere on the card; the keyboard only from the handle,
      // so Space in the menu or Enter on the link never starts one.
      onMouseDown={listeners?.['onMouseDown'] as React.MouseEventHandler | undefined}
      onTouchStart={listeners?.['onTouchStart'] as React.TouchEventHandler | undefined}
      className={isDragging ? 'opacity-40' : ''}
    >
      <CardBody
        application={application}
        onMove={onMove}
        handle={
          <button
            type="button"
            {...attributes}
            onKeyDown={listeners?.['onKeyDown'] as React.KeyboardEventHandler | undefined}
            aria-label={`Drag ${application.company}`}
            className="cursor-grab rounded px-1 text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-blue-600 dark:hover:text-slate-200"
          >
            <span aria-hidden="true">⠿</span>
          </button>
        }
      />
    </li>
  );
}

function CardBody({
  application,
  onMove,
  handle,
  preview = false,
}: {
  application: Application;
  onMove?: Props['onMove'];
  handle?: React.ReactNode;
  preview?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-950 ${
        preview ? 'rotate-1 shadow-lg' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        {preview ? (
          <span className="font-semibold">{application.company}</span>
        ) : (
          <Link
            to={`/applications/${application.id}`}
            className="font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            {application.company}
          </Link>
        )}
        {handle}
      </div>
      <p className="text-slate-600 dark:text-slate-300">{application.role}</p>
      {application.needsFollowUp && (
        <div>
          <FollowUpFlag />
        </div>
      )}
      {onMove && (
        <StatusMenu
          company={application.company}
          status={application.status}
          onMove={(to) => onMove(application, to)}
        />
      )}
    </div>
  );
}
