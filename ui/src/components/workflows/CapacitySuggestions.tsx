import { useCapacity, useDecideCapacity } from '../../api/capacity';
import { timeAgo } from '../../lib/time';
import { Button } from '../Button';
import { ErrorText } from '../form';

const LAST_LABELS = { pilot: 'O Órbi recebeu', applied: 'Aplicado', discarded: 'Descartado' } as const;

/**
 * Gestor de Capacidade: the agents of each step follow the queues, the computer and the Claude plan. Órbi's pilot
 * adjusts them; with the pilot off, the change waits here (and on the Órbi page) for the user.
 */
export function CapacitySuggestions({ workspaceId }: { workspaceId: string }) {
  const capacity = useCapacity(workspaceId);
  const decide = useDecideCapacity();
  const data = capacity.data;
  if (!data || (data.suggestions.length === 0 && !data.last)) return null;

  return (
    <section id="gestor-capacidade" className="scroll-mt-4 space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium">Gestor de Capacidade</h3>
        <p className="text-xs text-muted">
          Ajusta os agentes de cada etapa pelas filas, pelo computador e pelo plano Claude. Uma rotina do Órbi que vigia a capacidade decide por você;
          sem ela, a mudança espera você aqui.
        </p>
      </div>
      {data.suggestions.map((suggestion) => (
        <div key={suggestion.id} className="rounded-lg border border-accent/50 bg-panel p-3">
          <p className="text-xs whitespace-pre-line">{suggestion.summary}</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">{timeAgo(suggestion.createdAt)}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: suggestion.id, decision: 'apply' })}>
                Aplicar
              </Button>
              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: suggestion.id, decision: 'discard' })}>
                Descartar
              </Button>
            </div>
          </div>
        </div>
      ))}
      {data.last && data.suggestions.length === 0 && (
        <p className="text-xs text-muted">
          Último ajuste ({timeAgo(data.last.at)}) — {LAST_LABELS[data.last.status]}: <span className="whitespace-pre-line">{data.last.summary}</span>
        </p>
      )}
      <ErrorText error={decide.error} />
    </section>
  );
}
