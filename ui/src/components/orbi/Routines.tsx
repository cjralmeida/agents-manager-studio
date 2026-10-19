import { type ReactNode, useState } from 'react';
import { type OrbiRoutine, type RoutineInput, type RoutineMode, useDeleteRoutine, useRoutines, useRunRoutine, useSaveRoutine } from '../../api/orbi';
import { useWorkspaces } from '../../api/workspaces';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, TextInput } from '../form';

const MODES: { mode: RoutineMode; label: string; hint: string }[] = [
  { mode: 'auto', label: 'Automático', hint: 'Decide e age sozinho' },
  { mode: 'assistant', label: 'Assistente', hint: 'Mostra as opções e espera você' },
];

const EMPTY: RoutineInput = { name: '', instructions: '', workspaceIds: [], everyMinutes: null, dailyAt: [], events: [], mode: 'assistant', enabled: true };

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-accent' : 'bg-border'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[1.375rem]' : 'left-0.5'}`} />
    </button>
  );
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${active ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted hover:border-accent/50'}`}
    >
      {children}
    </button>
  );
}

/** "a cada 15 min · todo dia às 08:00 · 2 eventos", or what is missing. */
function whenText(routine: Pick<OrbiRoutine, 'everyMinutes' | 'dailyAt' | 'events'>) {
  const parts = [
    ...(routine.everyMinutes ? [`a cada ${routine.everyMinutes} min`] : []),
    ...(routine.dailyAt.length ? [`todo dia às ${routine.dailyAt.join(', ')}`] : []),
    ...(routine.events.length ? [`${routine.events.length} evento(s)`] : []),
  ];
  return parts.length ? parts.join(' · ') : 'só quando você manda rodar';
}

/** The routines: what Órbi does by itself, each with its schedule, workspaces, instructions and mode. */
export function RoutinesCard({ card }: { card: (title: string, aside: ReactNode, children: ReactNode) => ReactNode }) {
  const routines = useRoutines();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const list = routines.data?.routines ?? [];
  const events = routines.data?.events ?? {};

  return card(
    'Rotinas',
    editing !== 'new' && (
      <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
        Nova rotina
      </Button>
    ),
    <div className="space-y-2">
      {routines.error && <ErrorText error={routines.error} />}
      {!routines.data && !routines.error && <p className="text-xs text-muted">Carregando...</p>}
      {editing === 'new' && <RoutineForm events={events} onDone={() => setEditing(null)} />}
      {routines.data && list.length === 0 && editing !== 'new' && (
        <p className="text-xs text-muted">Nenhuma rotina ainda. Uma rotina é um trabalho que eu faço sozinho: num horário, de tempos em tempos ou quando algo acontece.</p>
      )}
      {list.map((routine) =>
        editing === routine.id ? (
          <RoutineForm key={routine.id} routine={routine} events={events} onDone={() => setEditing(null)} />
        ) : (
          <RoutineRow key={routine.id} routine={routine} onEdit={() => setEditing(routine.id)} />
        ),
      )}
    </div>,
  );
}

function RoutineRow({ routine, onEdit }: { routine: OrbiRoutine; onEdit: () => void }) {
  const save = useSaveRoutine();
  const run = useRunRoutine();
  const workspaces = useWorkspaces();
  const scope =
    routine.workspaceIds.length === 0
      ? 'Todos os workspaces'
      : (workspaces.data ?? []).filter((workspace) => routine.workspaceIds.includes(workspace.id)).map((workspace) => workspace.name).join(', ');
  return (
    <div className={`rounded-lg border px-3 py-2 ${routine.enabled ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface/60'}`}>
      <div className="flex items-center gap-2">
        <Switch checked={routine.enabled} disabled={save.isPending} onChange={(enabled) => save.mutate({ id: routine.id, enabled })} label={`Ligar a rotina ${routine.name}`} />
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left" title="Editar a rotina">
          <span className="block truncate text-sm font-medium">{routine.name}</span>
          <span className="block truncate text-[11px] text-muted">
            {scope} · {whenText(routine)}
          </span>
        </button>
        <Badge tone={routine.mode === 'auto' ? 'info' : 'warning'}>{routine.mode === 'auto' ? 'Automático' : 'Assistente'}</Badge>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>{routine.lastRunAt ? `Rodou ${timeAgo(routine.lastRunAt)}` : 'Ainda não rodou'}</span>
        <div className="flex gap-1.5">
          <Button size="sm" disabled={run.isPending} onClick={() => run.mutate(routine.id)} title="Manda a rotina para o Órbi agora, fora do horário">
            Rodar agora
          </Button>
          <Button size="sm" onClick={onEdit}>
            Editar
          </Button>
        </div>
      </div>
      <ErrorText error={save.error ?? run.error} />
    </div>
  );
}

function RoutineForm({ routine, events, onDone }: { routine?: OrbiRoutine; events: Record<string, string>; onDone: () => void }) {
  const save = useSaveRoutine();
  const remove = useDeleteRoutine();
  const workspaces = useWorkspaces();
  const available = workspaces.data?.filter((workspace) => !workspace.isMissing && !workspace.isIgnored) ?? [];
  const [draft, setDraft] = useState<RoutineInput>(() =>
    routine
      ? {
          name: routine.name,
          instructions: routine.instructions,
          workspaceIds: routine.workspaceIds,
          everyMinutes: routine.everyMinutes,
          dailyAt: routine.dailyAt,
          events: routine.events,
          mode: routine.mode,
          enabled: routine.enabled,
        }
      : EMPTY,
  );
  const [times, setTimes] = useState(draft.dailyAt.join(', '));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch: Partial<RoutineInput>) => setDraft((current) => ({ ...current, ...patch }));
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);

  const parsedTimes = times
    .split(/[,\s]+/)
    .map((time) => time.trim())
    .filter(Boolean)
    .map((time) => (/^\d:\d{2}$/.test(time) ? `0${time}` : time));
  const badTime = parsedTimes.find((time) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time));
  const canSave = draft.name.trim() && !badTime && !save.isPending;

  const submit = () =>
    save.mutate({ ...(routine && { id: routine.id }), ...draft, name: draft.name.trim(), dailyAt: parsedTimes }, { onSuccess: onDone });

  return (
    <div className="space-y-3 rounded-lg border border-accent/50 bg-surface/60 p-3">
      <TextInput value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="Nome (ex.: Fila da GlobalFarm)" maxLength={80} aria-label="Nome da rotina" />

      <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface p-1">
        {MODES.map(({ mode, label, hint }) => (
          <button
            key={mode}
            type="button"
            onClick={() => set({ mode })}
            className={`rounded-md px-2 py-1.5 text-left transition-colors ${draft.mode === mode ? 'bg-accent/15 text-accent' : 'text-muted hover:text-white'}`}
          >
            <span className="block text-xs font-medium">{label}</span>
            <span className="block text-[10px]">{hint}</span>
          </button>
        ))}
      </div>

      <div>
        <p className="mb-1 text-xs font-medium">Workspaces</p>
        <div className="flex flex-wrap gap-1.5">
          <Chip active={draft.workspaceIds.length === 0} onClick={() => set({ workspaceIds: [] })}>
            Todos
          </Chip>
          {available.map((workspace) => (
            <Chip key={workspace.id} active={draft.workspaceIds.includes(workspace.id)} onClick={() => set({ workspaceIds: toggle(draft.workspaceIds, workspace.id) })}>
              {workspace.name}
            </Chip>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium">Quando roda</p>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={draft.everyMinutes !== null} onChange={(event) => set({ everyMinutes: event.target.checked ? 30 : null })} />
          A cada
          <TextInput
            type="number"
            min={5}
            max={1440}
            disabled={draft.everyMinutes === null}
            value={draft.everyMinutes ?? 30}
            onChange={(event) => set({ everyMinutes: Math.max(5, Math.min(1440, Number(event.target.value) || 5)) })}
            className="w-20 py-1 text-xs"
            aria-label="Intervalo em minutos"
          />
          minutos
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="shrink-0">Todo dia às</span>
          <TextInput value={times} onChange={(event) => setTimes(event.target.value)} placeholder="08:00, 13:30" className="py-1 text-xs" aria-label="Horários" />
        </label>
        {badTime && <p className="text-[11px] text-red-300">"{badTime}" não é um horário (use HH:MM).</p>}
        <div>
          <p className="mb-1 text-[11px] text-muted">E quando acontecer:</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(events).map(([key, label]) => (
              <Chip key={key} active={draft.events.includes(key)} onClick={() => set({ events: toggle(draft.events, key) })}>
                {label}
              </Chip>
            ))}
          </div>
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs font-medium">Instruções</p>
        <textarea
          value={draft.instructions}
          onChange={(event) => set({ instructions: event.target.value })}
          rows={4}
          maxLength={8000}
          placeholder='O que olhar e como decidir. Ex.: "Veja as tarefas em validação; conflito de frontend vai para o ebur com o relatório na tarefa."'
          className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-accent"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} label="Rotina ligada" />
          {draft.enabled ? 'Ligada' : 'Desligada'}
        </label>
        <div className="flex gap-1.5">
          {routine &&
            (confirmDelete ? (
              <>
                <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(routine.id, { onSuccess: onDone })}>
                  Excluir
                </Button>
                <Button size="sm" onClick={() => setConfirmDelete(false)}>
                  Não
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setConfirmDelete(true)}>
                Excluir
              </Button>
            ))}
          <Button size="sm" onClick={onDone}>
            Cancelar
          </Button>
          <Button size="sm" variant="primary" disabled={!canSave} onClick={submit}>
            Salvar
          </Button>
        </div>
      </div>
      <ErrorText error={save.error ?? remove.error} />
    </div>
  );
}
