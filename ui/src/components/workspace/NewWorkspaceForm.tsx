import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCreateWorkspace } from '../../api/workspaces';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';

/** Creates the workspace folder in the central folder and opens the new workspace. */
export function NewWorkspaceForm({ onCancel }: { onCancel: () => void }) {
  const [name, setName] = useState('');
  const create = useCreateWorkspace();
  const navigate = useNavigate();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(name.trim(), { onSuccess: (workspace) => navigate(`/workspaces/${workspace.id}?tab=connectors`) });
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-panel p-4">
      <div className="min-w-64 flex-1">
        <Field label="Nome do workspace" hint="Vira uma pasta nova na pasta central; depois você coloca ou clona os projetos dentro dela.">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Clientes" autoFocus required />
        </Field>
      </div>
      <Button type="submit" variant="primary" disabled={create.isPending || !name.trim()}>
        {create.isPending ? 'Criando...' : 'Criar workspace'}
      </Button>
      <Button onClick={onCancel}>Cancelar</Button>
      <div className="w-full">
        <ErrorText error={create.error} />
      </div>
    </form>
  );
}
