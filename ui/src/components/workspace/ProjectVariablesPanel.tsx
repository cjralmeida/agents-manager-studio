import { type FormEvent, useState } from 'react';
import { useDeleteProjectVariable, useProjectVariables, useSetProjectVariable } from '../../api/previews';
import { Button } from '../Button';
import { ErrorText, TextInput } from '../form';

/**
 * Variables the project receives in "Rodar": the build and tests get them, and so does the running app (the
 * container, or every service of a compose stack, where ${VAR} in the file also reads them). Stored encrypted.
 */
export function ProjectVariablesPanel({ projectId }: { projectId: string }) {
  const variables = useProjectVariables(projectId, true);
  const save = useSetProjectVariable(projectId);
  const remove = useDeleteProjectVariable(projectId);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { name: name.trim(), value },
      {
        onSuccess: () => {
          setName('');
          setValue('');
        },
      },
    );
  };

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface/50 p-3">
      <p className="text-xs text-muted">
        <span className="font-medium text-gray-200">Variáveis de ambiente do Rodar.</span> Vão para o build, os testes e o app rodando (no
        compose, para todos os serviços e para os <span className="font-mono">{'${VAR}'}</span> do arquivo). Salvar verifica o projeto de novo.
      </p>
      {variables.data && variables.data.length > 0 && (
        <ul className="max-w-2xl divide-y divide-border rounded border border-border">
          {variables.data.map((variable) => (
            <li key={variable.key} className="flex items-center justify-between gap-2 px-2 py-1 text-xs">
              <span className="min-w-0 truncate">
                <span className="font-mono">{variable.key}</span> <span className="text-muted">{variable.valueHint}</span>
              </span>
              <span className="flex shrink-0 gap-1">
                <Button size="sm" onClick={() => setName(variable.key)} title="Preencha o novo valor abaixo">
                  Trocar
                </Button>
                <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(variable.key)}>
                  Remover
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {variables.data?.length === 0 && <p className="text-xs text-muted">Nenhuma variável.</p>}
      <form onSubmit={submit} className="flex max-w-2xl flex-col gap-1.5 sm:flex-row">
        <label className="sr-only" htmlFor={`var-name-${projectId}`}>
          Nome da variável
        </label>
        <TextInput
          id={`var-name-${projectId}`}
          value={name}
          onChange={(event) => setName(event.target.value.toUpperCase())}
          placeholder="NOME (ex.: DATABASE_URL)"
          className="py-1 font-mono text-xs sm:w-64"
          autoComplete="off"
        />
        <label className="sr-only" htmlFor={`var-value-${projectId}`}>
          Valor
        </label>
        <TextInput
          id={`var-value-${projectId}`}
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Valor"
          className="py-1 text-xs sm:flex-1"
          autoComplete="new-password"
        />
        <Button type="submit" size="sm" variant="primary" disabled={!name.trim() || save.isPending}>
          {save.isPending ? 'Salvando...' : 'Salvar'}
        </Button>
      </form>
      <ErrorText error={variables.error ?? save.error ?? remove.error} />
    </div>
  );
}
