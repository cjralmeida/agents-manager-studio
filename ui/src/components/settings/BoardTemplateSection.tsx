import { type FormEvent, useState } from 'react';
import { useStudioSettings, useUpdateStudioSettings } from '../../api/studioSettings';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';

export function BoardTemplateSection() {
  const settings = useStudioSettings();

  return (
    <section>
      <h2 className="text-base font-semibold">Modelo de quadro (GitHub)</h2>
      <p className="mt-1 text-sm text-muted">
        Quando o Studio cria um quadro no GitHub, ele copia este projeto: colunas, campos, views, automações e README.
        Sem modelo, usa o template próprio do Studio, com as mesmas colunas e campos, mas só com a view padrão.
        No GitLab o quadro é sempre criado com labels a partir do template do Studio.
      </p>
      {settings.data && <TemplateForm key={settings.dataUpdatedAt} initial={settings.data.githubBoardTemplateUrl ?? ''} />}
      <ErrorText error={settings.error} />
    </section>
  );
}

function TemplateForm({ initial }: { initial: string }) {
  const [url, setUrl] = useState(initial);
  const update = useUpdateStudioSettings();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ githubBoardTemplateUrl: url.trim() || null });
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-wrap items-end gap-3">
      <div className="min-w-80 flex-1">
        <Field label="URL do projeto-modelo">
          <TextInput
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/orgs/<organização>/projects/<número>"
          />
        </Field>
      </div>
      <Button type="submit" variant="primary" disabled={update.isPending || url.trim() === initial}>
        {update.isPending ? 'Salvando...' : 'Salvar'}
      </Button>
      {update.isSuccess && <span className="text-xs text-emerald-300">Salvo.</span>}
      <div className="w-full">
        <ErrorText error={update.error} />
      </div>
    </form>
  );
}
