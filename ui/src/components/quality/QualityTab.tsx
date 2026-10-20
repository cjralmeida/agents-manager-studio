import { useState } from 'react';
import { Link } from 'react-router';
import {
  type LearningPhase,
  type QualityCategory,
  type QualityStatus,
  learningPhases,
  qualityStatusLabels,
  useQuality,
  useUpdateQualityCategory,
} from '../../api/quality';
import type { WorkspaceDetail } from '../../api/workspaces';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Select, TextInput } from '../form';

const statusTone: Record<QualityStatus, 'warning' | 'info' | 'success' | 'neutral'> = {
  aberta: 'warning',
  transversal: 'info',
  resolvida: 'success',
  nao_defeito: 'neutral',
};

/** Different tasks with the same defect that call for a fix in the base (same as the server). */
const THRESHOLD = 3;

type StatusFilter = 'ensinando' | QualityStatus | 'todas';

const statusFilters: { id: StatusFilter; label: string }[] = [
  { id: 'ensinando', label: 'Ensinando os agentes' },
  { id: 'aberta', label: 'Abertas' },
  { id: 'transversal', label: 'Com correção na base' },
  { id: 'resolvida', label: 'Resolvidas' },
  { id: 'nao_defeito', label: 'Não é defeito' },
  { id: 'todas', label: 'Todas' },
];

const matchesStatus = (category: QualityCategory, filter: StatusFilter) =>
  filter === 'todas' ? true : filter === 'ensinando' ? category.status !== 'nao_defeito' : category.status === filter;

/**
 * Aprendizado: what blocked deliveries in review (code-guardian, homologation tests, play-tester), by stage and
 * category. Each lesson goes into the prompt of the agents of its stage, so a mistake fixed once is not made again; a
 * category in several tasks becomes a transversal task in the Backlog, for the user to approve.
 */
export function QualityTab({ workspace }: { workspace: WorkspaceDetail }) {
  const quality = useQuality(workspace.id);
  const [phase, setPhase] = useState<LearningPhase | 'todas'>('todas');
  const [status, setStatus] = useState<StatusFilter>('ensinando');
  const [search, setSearch] = useState('');
  if (quality.error) return <ErrorText error={quality.error} />;
  if (!quality.data) return <p className="text-sm text-muted">Lendo o aprendizado...</p>;

  const all = quality.data;
  const term = search.trim().toLowerCase();
  const visible = all.filter(
    (category) =>
      matchesStatus(category, status) &&
      (!term || `${category.name} ${category.lesson ?? ''} ${category.occurrences.map((entry) => entry.taskRef).join(' ')}`.toLowerCase().includes(term)),
  );
  const teaching = all.filter((category) => category.status !== 'nao_defeito');
  const stats = [
    { label: 'Lições ensinadas aos agentes', value: teaching.length, tone: 'text-accent' },
    { label: 'Com lição escrita', value: teaching.filter((category) => category.lesson).length, tone: 'text-gray-100' },
    { label: 'Pedem correção na base', value: all.filter((category) => category.status === 'aberta' && category.tasks >= THRESHOLD).length, tone: 'text-red-300' },
    { label: 'Resolvidas', value: all.filter((category) => category.status === 'resolvida').length, tone: 'text-emerald-300' },
  ];
  const sections = learningPhases.filter((entry) => phase === 'todas' || entry.id === phase);

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-muted">
        O que os revisores e testadores encontraram ao reprovar entregas — sempre "esperado × obtido" contra uma regra, um critério ou o contrato. Cada lição
        entra no prompt dos agentes da etapa dela, para não repetirem um erro já corrigido; os testadores também recebem as de codificação, para conferir a
        entrega. Uma categoria em {THRESHOLD} tarefas diferentes vira uma tarefa transversal no Backlog, para corrigir na base.
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-border bg-panel/40 px-4 py-3">
            <p className={`text-2xl font-semibold ${stat.tone}`}>{stat.value}</p>
            <p className="text-xs text-muted">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <PhasePill active={phase === 'todas'} onClick={() => setPhase('todas')} label="Todas as etapas" count={all.filter((category) => matchesStatus(category, status)).length} />
        {learningPhases.map((entry) => (
          <PhasePill
            key={entry.id}
            active={phase === entry.id}
            onClick={() => setPhase(entry.id)}
            label={entry.label}
            count={all.filter((category) => category.phase === entry.id && matchesStatus(category, status)).length}
          />
        ))}
        <div className="ml-auto flex flex-wrap gap-2">
          <Select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} aria-label="Situação" className="w-52!">
            {statusFilters.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
          <TextInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar categoria, lição ou tarefa" className="w-64!" />
        </div>
      </div>

      {all.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted">
          Nenhum aprendizado ainda. Os revisores registram aqui cada defeito que reprova uma entrega.
        </div>
      )}

      {sections.map((section) => {
        const categories = visible.filter((category) => category.phase === section.id);
        if (categories.length === 0 && phase === 'todas') return null;
        return (
          <section key={section.id} className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-2">
              <h3 className="font-semibold">{section.label}</h3>
              <span className="text-xs text-muted">quem aprende: {section.learners}</span>
            </div>
            {categories.length === 0 ? (
              <p className="text-sm text-muted">Nada nesta etapa com este filtro.</p>
            ) : (
              <ul className="grid gap-3 xl:grid-cols-2">
                {categories.map((category) => (
                  <LearningCard key={category.id} workspaceId={workspace.id} category={category} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function PhasePill({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
        active ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted hover:border-accent/50 hover:text-gray-200'
      }`}
    >
      {label} <span className="ml-1 text-xs opacity-70">{count}</span>
    </button>
  );
}

function LearningCard({ workspaceId, category }: { workspaceId: string; category: QualityCategory }) {
  const [showOccurrences, setShowOccurrences] = useState(false);
  const [editing, setEditing] = useState(false);
  const [lesson, setLesson] = useState(category.lesson ?? '');
  const update = useUpdateQualityCategory(workspaceId);
  const reached = category.status === 'aberta' && category.tasks >= THRESHOLD;
  const last = category.occurrences[0];

  const saveLesson = () => update.mutate({ id: category.id, lesson: lesson.trim() || null }, { onSuccess: () => setEditing(false) });

  return (
    <li className={`flex flex-col rounded-xl border bg-panel/40 p-4 ${reached ? 'border-red-500/40' : 'border-border'} ${category.status === 'nao_defeito' ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <h4 className="min-w-0 font-medium">{category.name}</h4>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {reached && <Badge tone="danger">pede correção na base</Badge>}
          <Badge tone={statusTone[category.status]}>{qualityStatusLabels[category.status]}</Badge>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2">
        <p className="text-[11px] font-medium tracking-wider text-accent uppercase">Lição</p>
        {editing ? (
          <div className="mt-1 space-y-2">
            <textarea
              value={lesson}
              onChange={(event) => setLesson(event.target.value)}
              rows={3}
              maxLength={1000}
              autoFocus
              placeholder='A correção a seguir, para quem trabalha na etapa: o que fazer, como e o teste que garante. Ex.: "Valide o corpo antes da regra e responda 400 no campo para tipo trocado, nunca 500; teste e2e cada caso".'
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={saveLesson} disabled={update.isPending}>
                Salvar
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setLesson(category.lesson ?? '');
                  setEditing(false);
                }}
              >
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="mt-0.5 w-full text-left text-sm hover:text-accent" title="Editar a lição">
            {category.lesson ?? (
              <span className="text-muted">
                Sem lição escrita: os agentes recebem o nome e o último esperado × obtido. <span className="text-accent">Escrever a lição</span>
              </span>
            )}
          </button>
        )}
      </div>

      {last && !showOccurrences && (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <p className="text-muted">Esperado</p>
            <p className="line-clamp-3">{last.expected}</p>
          </div>
          <div>
            <p className="text-muted">Obtido</p>
            <p className="line-clamp-3 text-red-200/90">{last.obtained}</p>
          </div>
        </div>
      )}

      {showOccurrences && (
        <ul className="mt-3 space-y-2">
          {category.occurrences.map((occurrence) => (
            <li key={occurrence.id} className="rounded-lg border border-border px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 text-muted">
                <span className="font-mono text-gray-300">{occurrence.taskRef}</span>
                <span>
                  {occurrence.agentId ? (
                    <Link to={`/agents/${occurrence.agentId}`} className="hover:text-accent">
                      {occurrence.reviewer ?? 'agente'}
                    </Link>
                  ) : (
                    (occurrence.reviewer ?? '—')
                  )}{' '}
                  · {timeAgo(occurrence.createdAt)}
                </span>
              </div>
              <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                <p>
                  <span className="text-muted">Esperado: </span>
                  {occurrence.expected}
                </p>
                <p>
                  <span className="text-muted">Obtido: </span>
                  <span className="text-red-200/90">{occurrence.obtained}</span>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted">
        <button type="button" onClick={() => setShowOccurrences(!showOccurrences)} className="hover:text-accent">
          {category.tasks} tarefa{category.tasks === 1 ? '' : 's'} · {category.occurrences.length} ocorrência{category.occurrences.length === 1 ? '' : 's'}{' '}
          {showOccurrences ? '▴' : '▾'}
        </button>
        {category.transversalRef && <span className="font-mono">{category.transversalRef}</span>}
        <span>· {timeAgo(category.updatedAt)}</span>
        <div className="ml-auto flex gap-1.5">
          <Select
            value={category.phase}
            onChange={(event) => update.mutate({ id: category.id, phase: event.target.value as LearningPhase })}
            disabled={update.isPending}
            aria-label="Etapa"
            className="w-36! py-0.5! text-xs!"
          >
            {learningPhases.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
          <Select
            value={category.status}
            onChange={(event) => update.mutate({ id: category.id, status: event.target.value as QualityStatus })}
            disabled={update.isPending}
            aria-label="Situação"
            className="w-44! py-0.5! text-xs!"
          >
            {(Object.keys(qualityStatusLabels) as QualityStatus[]).map((value) => (
              <option key={value} value={value}>
                {qualityStatusLabels[value]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <ErrorText error={update.error} />
    </li>
  );
}
