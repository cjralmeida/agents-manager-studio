import { useEffect, useState } from 'react';
import { type RoadmapSettings, useRoadmapSettings, useSaveRoadmapSettings } from '../../api/roadmaps';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const fromLocalInput = (value: string) => new Date(value).toISOString();

/**
 * How the workspace counts time for its roadmaps: the working calendar (days and hours), how long a stretch with
 * nothing running must be to count as a pause, and the pauses marked by hand.
 */
export function RoadmapSettingsPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const settings = useRoadmapSettings(workspaceId);
  const save = useSaveRoadmapSettings(workspaceId);
  const [draft, setDraft] = useState<RoadmapSettings | null>(null);
  const [pause, setPause] = useState({ from: '', to: '', reason: '' });

  useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data);
  }, [settings.data, draft]);

  if (!draft) return <p className="text-sm text-muted">Carregando...</p>;
  const allDay = draft.calendar.start === '00:00' && draft.calendar.end === '24:00';
  const update = (patch: Partial<RoadmapSettings['calendar']>) => setDraft({ ...draft, calendar: { ...draft.calendar, ...patch } });

  return (
    <section className="space-y-4 rounded-lg border border-border bg-panel p-4" aria-label="Calendário e pausas">
      <div className="flex items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold">Calendário de trabalho e pausas</h3>
        <Button size="sm" onClick={onClose}>
          Fechar
        </Button>
      </div>
      <p className="text-xs text-muted">
        O ritmo e as previsões contam só o tempo de trabalho deste workspace. Trechos maiores que o limite sem nenhum agente ou workflow rodando viram pausa
        sozinhos; marque abaixo as pausas que o Studio não vê (ex.: dias corrigindo o Studio com agentes ainda rodando).
      </p>

      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Dias de trabalho">
          <div className="flex flex-wrap gap-1">
            {weekdays.map((label, day) => {
              const active = draft.calendar.days.includes(day);
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => update({ days: active ? draft.calendar.days.filter((entry) => entry !== day) : [...draft.calendar.days, day].sort() })}
                  className={`rounded border px-2 py-1 text-xs ${active ? 'border-accent bg-accent/15' : 'border-border text-muted'}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="Horário">
          <Select value={allDay ? 'all' : 'hours'} onChange={(event) => update(event.target.value === 'all' ? { start: '00:00', end: '24:00' } : { start: '07:00', end: '17:00' })}>
            <option value="all">24 horas (agentes à noite)</option>
            <option value="hours">Expediente</option>
          </Select>
        </Field>
        {!allDay && (
          <Field label="Expediente">
            <div className="flex items-center gap-1">
              <TextInput type="time" value={draft.calendar.start} onChange={(event) => update({ start: event.target.value })} />
              <span className="text-muted">–</span>
              <TextInput type="time" value={draft.calendar.end} onChange={(event) => update({ end: event.target.value })} />
            </div>
          </Field>
        )}
        <Field label="Pausa automática após" hint="horas de trabalho sem nada rodando">
          <TextInput
            type="number"
            min={1}
            max={72}
            value={draft.autoPauseHours}
            onChange={(event) => setDraft({ ...draft, autoPauseHours: Number(event.target.value) || 1 })}
          />
        </Field>
      </div>

      <div>
        <h4 className="text-xs font-medium text-gray-300">Pausas marcadas</h4>
        {draft.pauses.length === 0 ? (
          <p className="mt-1 text-xs text-muted">Nenhuma.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {draft.pauses.map((entry, index) => (
              <li key={`${entry.from}-${index}`} className="flex items-center gap-2 text-xs">
                <span>
                  {new Date(entry.from).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} →{' '}
                  {new Date(entry.to).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
                {entry.reason && <span className="text-muted">· {entry.reason}</span>}
                <button
                  type="button"
                  className="ml-auto text-red-300 hover:underline"
                  onClick={() => setDraft({ ...draft, pauses: draft.pauses.filter((_, other) => other !== index) })}
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 grid gap-2 md:grid-cols-[1fr_1fr_2fr_auto]">
          <TextInput type="datetime-local" aria-label="Início da pausa" value={pause.from} onChange={(event) => setPause({ ...pause, from: event.target.value })} />
          <TextInput type="datetime-local" aria-label="Fim da pausa" value={pause.to} onChange={(event) => setPause({ ...pause, to: event.target.value })} />
          <TextInput placeholder="Motivo (ex.: correção do Studio)" value={pause.reason} onChange={(event) => setPause({ ...pause, reason: event.target.value })} />
          <Button
            size="sm"
            disabled={!pause.from || !pause.to || pause.to <= pause.from}
            onClick={() => {
              setDraft({ ...draft, pauses: [...draft.pauses, { from: fromLocalInput(pause.from), to: fromLocalInput(pause.to), reason: pause.reason.trim() }] });
              setPause({ from: '', to: '', reason: '' });
            }}
          >
            Adicionar
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={save.isPending || draft.calendar.days.length === 0} onClick={() => save.mutate(draft)}>
          {save.isPending ? 'Salvando...' : 'Salvar'}
        </Button>
        {save.isSuccess && <span className="text-xs text-emerald-300">Salvo. As previsões foram recalculadas.</span>}
        <ErrorText error={save.error} />
      </div>
    </section>
  );
}

