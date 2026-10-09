import { type FormEvent, useState } from 'react';
import { useAgentVariables, useDeleteAgentVariable, useSetAgentVariable } from '../../api/workspaceSettings';
import { Button } from '../Button';
import { ErrorText, TextInput } from '../form';

/** Values the agents read in their container (e.g. a test login for homologation); stored encrypted, never shown again. */
export function AgentVariablesSection({ workspaceId }: { workspaceId: string }) {
  const variables = useAgentVariables(workspaceId);
  const setVariable = useSetAgentVariable(workspaceId);
  const deleteVariable = useDeleteAgentVariable(workspaceId);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setVariable.mutate(
      { key: key.trim(), value },
      {
        onSuccess: () => {
          setKey('');
          setValue('');
        },
      },
    );
  };

  if (variables.error) return <ErrorText error={variables.error} />;
  return (
    <div className="space-y-3">
      {variables.data && variables.data.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {variables.data.map((variable) => (
            <li key={variable.key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="font-mono">{variable.key}</span>
                <span className="ml-2 text-xs text-muted">{variable.valueHint}</span>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" onClick={() => setKey(variable.key)} title="Preencha o novo valor abaixo">
                  Trocar valor
                </Button>
                <Button size="sm" variant="danger" disabled={deleteVariable.isPending} onClick={() => deleteVariable.mutate(variable.key)}>
                  Remover
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{variables.isLoading ? 'Carregando...' : 'Nenhuma variável.'}</p>
      )}

      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <TextInput
          value={key}
          onChange={(event) => setKey(event.target.value.toUpperCase())}
          placeholder="NOME (ex.: HOM_USER_EMAIL)"
          className="font-mono sm:w-64"
          autoComplete="off"
        />
        <TextInput
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Valor"
          className="sm:flex-1"
          autoComplete="new-password"
        />
        <Button type="submit" variant="primary" disabled={!key.trim() || !value || setVariable.isPending}>
          Salvar
        </Button>
      </form>
      <ErrorText error={setVariable.error ?? deleteVariable.error} />
    </div>
  );
}
