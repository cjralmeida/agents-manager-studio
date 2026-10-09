import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useHostHelper, useRequestProjectsRoot, useStudioSettings } from '../../api/studioSettings';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { CommandBox } from '../CopyButton';
import { ErrorText, Field, TextInput } from '../form';
import { ProjectsRootRestart, type RestartTarget } from './ProjectsRootRestart';

const splitNames = (value: string) =>
  value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

/** The central folder: where workspaces live and where new ones are created. Changing it restarts the Studio. */
export function ProjectsRootSection() {
  const settings = useStudioSettings();
  const helper = useHostHelper();
  const request = useRequestProjectsRoot();
  const root = settings.data?.projectsRoot;
  const [hostPath, setHostPath] = useState('');
  const [excluded, setExcluded] = useState('');
  const [restart, setRestart] = useState<RestartTarget | null>(null);
  const closeRestart = useCallback(() => setRestart(null), []);

  useEffect(() => {
    if (!root) return;
    setHostPath(root.hostPath);
    setExcluded(root.excluded.join(', '));
  }, [root]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const names = splitNames(excluded);
    request.mutate(
      { hostPath, excluded: names },
      { onSuccess: (answer) => setRestart({ hostPath: answer.hostPath, excluded: names, requestId: answer.requestId, command: answer.command }) },
    );
  };

  return (
    <section>
      <h2 className="text-base font-semibold">Pasta central</h2>
      <p className="mt-1 text-sm text-muted">
        Cada pasta dentro dela é um workspace, e os workspaces novos são criados aqui. O Studio só escreve nesta pasta.
      </p>
      <ErrorText error={settings.error} />

      {root && (
        <form onSubmit={handleSubmit} className="mt-4 space-y-4 rounded-lg border border-border bg-panel p-4 text-sm">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Pasta central" hint="Caminho no Windows, como D:/Projetos. A pasta precisa existir.">
              <TextInput value={hostPath} onChange={(event) => setHostPath(event.target.value)} spellCheck={false} required />
            </Field>
            <Field label="Pastas ignoradas" hint="Separadas por vírgula; não viram workspaces.">
              <TextInput value={excluded} onChange={(event) => setExcluded(event.target.value)} placeholder="Ex.: Pessoais, Arquivo" spellCheck={false} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={request.isPending || !hostPath.trim()}>
              Aplicar e reiniciar o Studio
            </Button>
            <span className="text-xs text-muted">Os agentes em execução são interrompidos durante o reinício.</span>
          </div>
          <ErrorText error={request.error} />
        </form>
      )}

      <div className="mt-4 rounded-lg border border-border p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Ajudante do Windows</span>
          {helper.data?.online ? <Badge tone="success">Ativo</Badge> : <Badge tone="warning">Não está rodando</Badge>}
        </div>
        <p className="mt-1 text-xs text-muted">
          O <code className="font-mono">studio.ps1</code> roda escondido no Windows e faz a troca: atualiza o{' '}
          <code className="font-mono">.env</code> e recria o server com a nova pasta. Sem ele, o Studio mostra um comando para você
          rodar.
        </p>
        {helper.data && !helper.data.online && (
          <div className="mt-3 space-y-1">
            <p className="text-xs text-muted">Para ativar e iniciar junto com o Windows, rode uma vez no PowerShell:</p>
            <CommandBox command={helper.data.installCommand} />
          </div>
        )}
      </div>

      {restart && <ProjectsRootRestart target={restart} onClose={closeRestart} />}
    </section>
  );
}
