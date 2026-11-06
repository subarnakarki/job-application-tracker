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
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { STAGE_COLOR } from '../stage';
import { useMediaQuery } from '../useMediaQuery';
import { Link } from 'react-router';
import { FollowUpFlag } from './StatusBadge';
import { StatusMenu } from './StatusMenu';
import { interviewText } from '../timeline';

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
  // The card that was just dropped, for a short "pop" in its new column.
  const [dropped, setDropped] = useState<string | null>(null);
  const droppedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(droppedTimer.current), []);
  // Phones get one stage at a time, as tabs; moves there use each card's Move to menu.
  const phone = useMediaQuery('(max-width: 639px)');
  const [tab, setTab] = useState<Status | null>(null);
  const selected: Status =
    tab ?? STATUSES.find((status) => items.some((item) => item.status === status)) ?? 'Saved';
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
    if (application && to && to !== application.status) {
      onMove(application, to);
      setDropped(application.id);
      window.clearTimeout(droppedTimer.current);
      droppedTimer.current = window.setTimeout(() => setDropped(null), 900);
    }
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
      {phone ? (
        <div role="region" aria-label="Board" className="flex flex-col gap-3">
          <StageTabs items={items} selected={selected} onSelect={setTab} />
          <div
            role="tabpanel"
            id={`board-panel-${selected}`}
            aria-labelledby={`board-tab-${selected}`}
          >
            <Column
              status={selected}
              items={items.filter((item) => item.status === selected)}
              onMove={onMove}
              dropped={dropped}
              fullWidth
              draggable={false}
            />
          </div>
        </div>
      ) : (
        <>
          <p className="-mt-2 mb-3 text-xs text-fg-3">
            Drag a card to another stage, or focus{' '}
            <kbd className="rounded-[5px] border border-line-2 px-1.5 font-[inherit] text-fg-2">
              ⠿
            </kbd>{' '}
            and use Space and the arrow keys.
          </p>
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
                dropped={dropped}
              />
            ))}
          </div>
        </>
      )}
      <DragOverlay>{dragging && <CardBody application={dragging} preview />}</DragOverlay>
    </DndContext>
  );
}

/** One tab per stage with its count. Left/Right/Home/End move between tabs (the ARIA tabs pattern). */
function StageTabs({
  items,
  selected,
  onSelect,
}: {
  items: Application[];
  selected: Status;
  onSelect: (status: Status) => void;
}) {
  const choose = (status: Status) => {
    onSelect(status);
    document.getElementById(`board-tab-${status}`)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Stages"
      className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1"
    >
      {STATUSES.map((status, index) => {
        const active = status === selected;
        const count = items.filter((item) => item.status === status).length;
        return (
          <button
            key={status}
            id={`board-tab-${status}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`board-panel-${status}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(status)}
            onKeyDown={(event) => {
              const last = STATUSES.length - 1;
              const target =
                event.key === 'ArrowRight'
                  ? STATUSES[index === last ? 0 : index + 1]
                  : event.key === 'ArrowLeft'
                    ? STATUSES[index === 0 ? last : index - 1]
                    : event.key === 'Home'
                      ? STATUSES[0]
                      : event.key === 'End'
                        ? STATUSES[last]
                        : undefined;
              if (target) {
                event.preventDefault();
                choose(target);
              }
            }}
            className={`flex min-h-11 shrink-0 snap-start items-center gap-2 rounded-full px-4 text-[0.8125rem] transition-colors ${
              active ? 'bg-white text-black' : 'text-fg-2 shadow-line hover:text-fg'
            }`}
          >
            {status}{' '}
            <span className={`tabular-nums ${active ? 'text-black' : 'text-fg-3'}`}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

function Column({
  status,
  items,
  onMove,
  dropped,
  fullWidth = false,
  draggable = true,
}: {
  status: Status;
  items: Application[];
  onMove: Props['onMove'];
  dropped: string | null;
  fullWidth?: boolean;
  draggable?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const headingId = `column-${status}`;
  return (
    <section
      ref={setNodeRef}
      aria-labelledby={headingId}
      style={{ '--c': STAGE_COLOR[status] } as CSSProperties}
      className={`board-col flex flex-col ${fullWidth ? 'w-full' : 'w-64 shrink-0 snap-start lg:w-auto lg:min-w-40 lg:flex-1 lg:shrink'} gap-2 rounded-[1.125rem] p-1 ${
        isOver ? 'board-col-over' : ''
      }`}
    >
      <h2
        id={headingId}
        className={`flex items-center gap-2 px-1.5 pt-1.5 pb-1 text-[0.8125rem] font-medium transition-colors ${
          isOver ? 'text-fg' : isClosed(status) ? 'text-fg-3' : 'text-fg-2'
        }`}
      >
        <i
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: 'var(--c)', boxShadow: '0 0 10px var(--c)' }}
        />
        <span>{status}</span>
        <span
          className={`ml-auto text-fg-3 tabular-nums ${
            dropped && items.some((item) => item.id === dropped) ? 'count-bump' : ''
          }`}
        >
          {items.length}
        </span>
      </h2>
      {items.length === 0 && (
        <p className="rounded-[0.875rem] border border-dashed border-line-2 px-1.5 py-2.5 text-center text-xs text-fg-3">
          No applications
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {items.map((application) =>
          draggable ? (
            <DraggableCard
              key={application.id}
              application={application}
              onMove={onMove}
              justDropped={dropped === application.id}
            />
          ) : (
            <li key={application.id}>
              <CardBody
                application={application}
                onMove={onMove}
                justDropped={dropped === application.id}
              />
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

function DraggableCard({
  application,
  onMove,
  justDropped,
}: {
  application: Application;
  onMove: Props['onMove'];
  justDropped: boolean;
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
      className={`transition-[opacity,transform] duration-200 ${isDragging ? 'scale-[0.98] opacity-[0.28]' : ''}`}
    >
      <CardBody
        application={application}
        onMove={onMove}
        justDropped={justDropped}
        handle={
          <button
            type="button"
            {...attributes}
            onKeyDown={listeners?.['onKeyDown'] as React.KeyboardEventHandler | undefined}
            aria-label={`Drag ${application.company}`}
            className="-mt-1 -mr-1.5 grid size-7 cursor-grab place-items-center rounded-lg text-fg-3 transition-colors hover:bg-white/10 hover:text-fg"
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
  justDropped = false,
}: {
  application: Application;
  onMove?: Props['onMove'];
  handle?: React.ReactNode;
  preview?: boolean;
  justDropped?: boolean;
}) {
  return (
    <div
      style={{ '--c': STAGE_COLOR[application.status] } as CSSProperties}
      className={`glow flex flex-col gap-1.5 rounded-2xl p-3.5 text-sm ${
        preview ? 'board-card-lifted' : 'transition-transform duration-300 hover:-translate-y-0.5'
      } ${justDropped ? 'board-card-dropped' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        {preview ? (
          <span className="font-medium tracking-[-0.02em]">{application.company}</span>
        ) : (
          <Link
            to={`/applications/${application.id}`}
            className="font-medium tracking-[-0.02em] hover:underline"
          >
            {application.company}
          </Link>
        )}
        {handle}
      </div>
      <p className="text-[0.8125rem] text-fg-2">{application.role}</p>
      {interviewText(application) && (
        <p className="text-xs font-medium text-[#d4a6ff]">{interviewText(application)}</p>
      )}
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
          className="mt-1 w-full"
        />
      )}
    </div>
  );
}
