import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { useCapacity } from '../../api/capacity';
import { timeAgo } from '../../lib/time';
import { ProposalCard } from '../orbi/ProposalCard';

/**
 * Gestor de Capacidade: suggestions to run more or fewer tasks at once in the board workflows. It only suggests;
 * nothing changes until the user applies a card.
 */
export function CapacitySuggestions({ workspaceId }: { workspaceId: string }) {
  const capacity = useCapacity(workspaceId);
  const data = capacity.data;
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const shown = Boolean(data && (data.suggestions.length > 0 || data.lastAnalysisAt));
  // Opened from the notice: bring the cards into view (instant; a smooth scroll froze the canvas once).
  useEffect(() => {
    if (shown && location.hash === '#gestor-capacidade') section.current?.scrollIntoView({ block: 'start' });
  }, [shown, location.hash]);
  if (!data || !shown) return null;

  return (
    <section id="gestor-capacidade" ref={section} className="scroll-mt-4 space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium">Gestor de Capacidade</h3>
        <p className="text-xs text-muted">
          Acompanha o quadro e o plano Claude e sugere quantas tarefas cada workflow roda ao mesmo tempo.
          {data.lastAnalysisAt && <> Última análise {timeAgo(data.lastAnalysisAt)}.</>}
          {data.lastConversationId && (
            <>
              {' '}
              <Link to={`/agents/${data.lastConversationId}`} className="text-accent hover:underline">
                Ver o raciocínio
              </Link>
            </>
          )}
        </p>
      </div>
      {data.suggestions.length > 0 ? (
        <div className="grid gap-2 md:grid-cols-2">
          {data.suggestions.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} workspaceId={workspaceId} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">Nenhuma sugestão pendente.</p>
      )}
    </section>
  );
}
