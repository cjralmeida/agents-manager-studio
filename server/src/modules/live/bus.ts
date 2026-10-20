import { EventEmitter } from 'node:events';

/**
 * Changes the open screens should show at once (Server-Sent Events, /api/events): a board read again with something
 * new (a git webhook, the periodic read), or a task the Studio or an agent changed. A burst for the same workspace
 * (a move that also releases dependents) becomes one event.
 */
export interface LiveEvent {
  type: 'board';
  workspaceId: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);
const pending = new Map<string, NodeJS.Timeout>();

export function boardChanged(workspaceId: string) {
  if (pending.has(workspaceId)) return;
  pending.set(
    workspaceId,
    setTimeout(() => {
      pending.delete(workspaceId);
      bus.emit('event', { type: 'board', workspaceId } satisfies LiveEvent);
    }, 300),
  );
}

export function onLiveEvent(listener: (event: LiveEvent) => void) {
  bus.on('event', listener);
  return () => {
    bus.off('event', listener);
  };
}
