import { type FormEvent, useState } from 'react';
import { type Board, useCreateTask } from '../../api/boards';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

const DRAFT = '__draft__';

/** Creates an issue in a workspace repository (or a GitHub draft) and adds it to the board. */
export function NewTaskForm({ workspaceId, board, onClose }: { workspaceId: string; board: Board; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [repository, setRepository] = useState(board.repositories[0]?.path ?? (board.supportsDrafts ? DRAFT : ''));
  const [columnId, setColumnId] = useState(board.link.statusMap.todo ?? board.columns[0]?.id ?? '');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [body, setBody] = useState(board.taskBodyTemplate);
  const create = useCreateTask(workspaceId);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { title, body, repository: repository === DRAFT ? null : repository, columnId: columnId || null, fields },
      { onSuccess: onClose },
    );
  };

  const noTarget = board.repositories.length === 0 && !board.supportsDrafts;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-6" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-2xl rounded-xl border border-border bg-surface p-5 shadow-2xl"
      >
        <h2 className="text-lg font-semibold">Nova tarefa</h2>
        <p className="mt-1 text-xs text-muted">
          {board.link.provider === 'GITHUB'
            ? 'Cria uma issue no repositório escolhido e a adiciona ao projeto.'
            : 'Cria uma issue no projeto escolhido; colunas e campos viram labels.'}
        </p>

        <div className="mt-4 space-y-3">
          <Field label="Título">
            <TextInput value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Repositório">
              <Select value={repository} onChange={(event) => setRepository(event.target.value)} required>
                {board.repositories.map((repo) => (
                  <option key={repo.path} value={repo.path}>
                    {repo.projectName} ({repo.path})
                  </option>
                ))}
                {board.supportsDrafts && <option value={DRAFT}>Sem repositório (rascunho)</option>}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={columnId} onChange={(event) => setColumnId(event.target.value)}>
                {board.columns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </Select>
            </Field>
            {board.fields.map((field) => (
              <Field key={field.id} label={field.name}>
                <Select
                  value={fields[field.id] ?? ''}
                  onChange={(event) => {
                    const { [field.id]: _removed, ...rest } = fields;
                    setFields(event.target.value ? { ...rest, [field.id]: event.target.value } : rest);
                  }}
                >
                  <option value="">—</option>
                  {field.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
          <Field label="Descrição">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={10}
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-sm outline-none focus:border-accent"
            />
          </Field>
        </div>

        {noTarget && <p className="mt-3 text-sm text-amber-300">Nenhum projeto do workspace está neste provedor.</p>}
        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={create.isPending || !title.trim() || noTarget}>
            {create.isPending ? 'Criando...' : 'Criar tarefa'}
          </Button>
          <Button onClick={onClose}>Cancelar</Button>
          <ErrorText error={create.error} />
        </div>
      </form>
    </div>
  );
}
