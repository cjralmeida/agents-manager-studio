import { useState } from 'react';
import { Link } from 'react-router';
import { type QualityCategory, type QualityStatus, qualityStatusLabels, useQuality, useUpdateQualityCategory } from '../../api/quality';
import type { WorkspaceDetail } from '../../api/workspaces';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { ErrorText, Select } from '../form';

const statusTone: Record<QualityStatus, 'warning' | 'info' | 'success' | 'neutral'> = {
  aberta: 'warning',
  transversal: 'info',
  resolvida: 'success',
  nao_defeito: 'neutral',
};

/** Different tasks with the same defect that call for a fix in the base (same as the server). */
const THRESHOLD = 3;

/**
 * Recurring defects: what blocked tasks in review (code-guardian, homologation tests, play-tester), by category.
 * A category in several tasks becomes a transversal task in the Backlog, for the user to approve.
 */
export function QualityTab({ workspace }: { workspace: WorkspaceDetail }) {
  const quality = useQuality(workspace.id);
  if (quality.error) return <ErrorText error={quality.error} />;
  if (!quality.data) return <p className="text-sm text-muted">Lendo o registro...</p>;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">
        Defeitos que fizeram os revisores reprovar uma entrega, agrupados por categoria — sempre "esperado × obtido" contra uma regra, um
        critério ou o contrato; erro esperado de um teste contrário não entra. Quando uma categoria aparece em {THRESHOLD} tarefas diferentes, o
        revisor abre uma tarefa transversal no Backlog (com Decisão = "Aguardando decisão") para corrigir na base; quando ela é
        concluída, a categoria fica "Resolvida" sozinha.
      </p>
      {quality.data.length === 0 ? (
        <p className="text-sm text-muted">Nenhum defeito registrado ainda.</p>
      ) : (
        <ul className="space-y-3">
          {quality.data.map((category) => (
            <CategoryRow key={category.id} workspaceId={workspace.id} category={category} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CategoryRow({ workspaceId, category }: { workspaceId: string; category: QualityCategory }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateQualityCategory(workspaceId);
  const reached = category.status === 'aberta' && category.tasks >= THRESHOLD;

  return (
    <li className="rounded-lg border border-border bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 text-left">
          <span className="font-medium">{category.name}</span>
          <span className="ml-2 text-xs text-muted">
            {category.tasks} tarefa{category.tasks === 1 ? '' : 's'} · {category.occurrences.length} ocorrência
            {category.occurrences.length === 1 ? '' : 's'} · {timeAgo(category.updatedAt)}
          </span>
        </button>
        <div className="flex items-center gap-2">
          {reached && <Badge tone="danger">pede correção na base</Badge>}
          {category.transversalRef && <span className="text-xs text-muted">{category.transversalRef}</span>}
          <Badge tone={statusTone[category.status]}>{qualityStatusLabels[category.status]}</Badge>
          <Select
            value={category.status}
            onChange={(event) => update.mutate({ id: category.id, status: event.target.value as QualityStatus })}
            disabled={update.isPending}
            aria-label="Situação da categoria"
            className="w-48!"
          >
            {(Object.keys(qualityStatusLabels) as QualityStatus[]).map((status) => (
              <option key={status} value={status}>
                {qualityStatusLabels[status]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <ErrorText error={update.error} />
      {open && (
        <table className="mt-3 w-full text-xs">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 pr-3 font-normal">Tarefa</th>
              <th className="py-1 pr-3 font-normal">Esperado</th>
              <th className="py-1 pr-3 font-normal">Obtido</th>
              <th className="py-1 font-normal">Quem registrou</th>
            </tr>
          </thead>
          <tbody>
            {category.occurrences.map((occurrence) => (
              <tr key={occurrence.id} className="border-t border-border align-top">
                <td className="py-1.5 pr-3">{occurrence.taskRef}</td>
                <td className="py-1.5 pr-3">{occurrence.expected}</td>
                <td className="py-1.5 pr-3">{occurrence.obtained}</td>
                <td className="py-1.5 text-muted">
                  {occurrence.agentId ? (
                    <Link to={`/agents/${occurrence.agentId}`} className="hover:text-accent">
                      {occurrence.reviewer ?? 'agente'}
                    </Link>
                  ) : (
                    (occurrence.reviewer ?? '—')
                  )}{' '}
                  · {timeAgo(occurrence.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}
