import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

interface LiveEvent {
  type: 'board';
  workspaceId: string;
}

/**
 * Listens to the server's changes (/api/events) while the Studio is open: a board changed (a git webhook, the periodic
 * read, a task moved by the Studio or an agent) reloads that board, the joined board and the stuck tasks at once.
 * The browser reconnects by itself; the queries keep a slow refetch as a fallback.
 */
export function useLiveUpdates(enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/events');
    source.onmessage = (message) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(message.data) as LiveEvent;
      } catch {
        return;
      }
      if (event.type === 'board') {
        void queryClient.invalidateQueries({ queryKey: ['board', event.workspaceId, 'contents'] });
        void queryClient.invalidateQueries({ queryKey: ['board', event.workspaceId, 'sources'] });
        void queryClient.invalidateQueries({ queryKey: ['board-overview'] });
        void queryClient.invalidateQueries({ queryKey: ['boards', 'stuck'] });
      }
    };
    return () => source.close();
  }, [enabled, queryClient]);
}
