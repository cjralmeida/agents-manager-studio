import { useAgentDiff } from '../../api/agents';
import { Button } from '../Button';
import { ErrorText } from '../form';

const fileStatusLabels: Record<string, string> = { A: 'novo', M: 'alterado', D: 'removido', R: 'renomeado' };

function lineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted';
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-200';
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-200';
  if (line.startsWith('@@')) return 'text-accent';
  if (line.startsWith('diff --git')) return 'mt-4 border-t border-border pt-2 font-semibold text-gray-200';
  return 'text-gray-400';
}

export function DiffView({ agentId }: { agentId: string }) {
  const diff = useAgentDiff(agentId, true);

  if (diff.isPending) return <p className="text-sm text-muted">Calculando alterações...</p>;
  if (diff.error) return <ErrorText error={diff.error} />;

  const { files, patch, truncated } = diff.data;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {files.length === 0 ? 'Nenhuma alteração ainda.' : `${files.length} arquivo(s) alterado(s)`}
        </p>
        <Button size="sm" onClick={() => void diff.refetch()} disabled={diff.isFetching}>
          Atualizar
        </Button>
      </div>

      {files.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {files.map((file) => (
            <li key={file.path} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="truncate font-mono text-xs">{file.path}</span>
              <span className="flex shrink-0 gap-3 text-xs">
                <span className="text-muted">{fileStatusLabels[file.status] ?? file.status}</span>
                {file.additions !== null && <span className="text-emerald-300">+{file.additions}</span>}
                {file.deletions !== null && <span className="text-red-300">-{file.deletions}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {patch && (
        <pre className="overflow-x-auto rounded-lg border border-border bg-panel p-3 font-mono text-xs leading-5">
          {patch.split('\n').map((line, index) => (
            <div key={index} className={`px-1 whitespace-pre ${lineClass(line)}`}>
              {line || ' '}
            </div>
          ))}
        </pre>
      )}
      {truncated && <p className="text-xs text-amber-300">Diff muito grande; mostrando só o início.</p>}
    </div>
  );
}
