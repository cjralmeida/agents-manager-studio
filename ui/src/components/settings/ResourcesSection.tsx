import { type FormEvent, useEffect, useState } from 'react';
import {
  type ResourceSettings,
  type ResourceSuggestion,
  SIZE_NAMES,
  type SizeName,
  type UsageStats,
  useResourceOverview,
  useSaveResourceSettings,
  useSetProfileSize,
} from '../../api/resourceSettings';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, Select, TextInput } from '../form';

const gb = (mb: number) => `${(mb / 1024).toFixed(1).replace('.0', '')} GB`;
const toMb = (value: string) => Math.round(Number(value.replace(',', '.')) * 1024);
const toGb = (mb: number) => String(Math.round((mb / 1024) * 100) / 100);

const sizeHint: Record<SizeName, string> = {
  P: 'Órbi, especificação, tarefas, roadmap, publicação',
  M: 'frontend, testes de telas e da API, jogos',
  G: 'backend (build Java e testes e2e)',
  GG: 'só depois de faltar memória no G',
};

/** Form values as typed (GB with decimals), turned into settings on save. */
interface Draft {
  reservedCpus: string;
  reservedMemoryGb: string;
  cpuOvercommit: string;
  sizes: Record<SizeName, { cpus: string; memoryGb: string; reserveGb: string }>;
}

function toDraft(settings: ResourceSettings): Draft {
  return {
    reservedCpus: String(settings.reservedCpus),
    reservedMemoryGb: toGb(settings.reservedMemoryMb),
    cpuOvercommit: String(settings.cpuOvercommit),
    sizes: Object.fromEntries(
      SIZE_NAMES.map((name) => {
        const size = settings.sizes[name];
        return [
          name,
          {
            cpus: String(size.cpus),
            memoryGb: toGb(size.memoryMb),
            reserveGb: toGb(size.reserveMb),
          },
        ];
      }),
    ) as Draft['sizes'],
  };
}

function fromDraft(draft: Draft): ResourceSettings {
  return {
    reservedCpus: Number(draft.reservedCpus.replace(',', '.')),
    reservedMemoryMb: toMb(draft.reservedMemoryGb),
    cpuOvercommit: Number(draft.cpuOvercommit.replace(',', '.')),
    sizes: Object.fromEntries(
      SIZE_NAMES.map((name) => {
        const size = draft.sizes[name];
        return [
          name,
          {
            name,
            cpus: Number(size.cpus.replace(',', '.')),
            memoryMb: toMb(size.memoryGb),
            reserveMb: toMb(size.reserveGb),
          },
        ];
      }),
    ) as ResourceSettings['sizes'],
  };
}

function usageText(usage: UsageStats) {
  if (usage.agents === 0) return 'sem medição ainda';
  return `${usage.agents} agentes · pico ${gb(usage.p90PeakMemoryMb)} (máx. ${gb(usage.maxPeakMemoryMb)}) · CPU média ${usage.p90AvgCpuPercent}%${usage.ooms ? ` · ${usage.ooms} sem memória` : ''}`;
}

function suggestionTitle(suggestion: ResourceSuggestion) {
  if (suggestion.kind === 'reserve') return `Reserva do ${suggestion.size}: ${gb(suggestion.from)} → ${gb(suggestion.to)}`;
  if (suggestion.kind === 'memory') return `Limite de memória do ${suggestion.size}: ${gb(suggestion.from)} → ${gb(suggestion.to)}`;
  return `${suggestion.profile} (${suggestion.workspace}): ${suggestion.from} → ${suggestion.to}`;
}

/**
 * Configurações → Recursos: the CPU and memory of each agent size, what the machine keeps for the Studio, the size of
 * each workspace agent, and the Gestor de Capacidade's suggestions from what the agents really used.
 */
export function ResourcesSection({ isAdmin }: { isAdmin: boolean }) {
  const overview = useResourceOverview();
  const save = useSaveResourceSettings();
  const setProfileSize = useSetProfileSize();
  const [draft, setDraft] = useState<Draft | null>(null);
  const data = overview.data;

  useEffect(() => {
    if (data) setDraft(toDraft(data.settings));
  }, [data]);

  if (!data || !draft) return <ErrorText error={overview.error} />;

  const changed = JSON.stringify(fromDraft(draft)) !== JSON.stringify(data.settings);

  const setSize = (name: SizeName, field: keyof Draft['sizes'][SizeName], value: string) =>
    setDraft({
      ...draft,
      sizes: {
        ...draft.sizes,
        [name]: { ...draft.sizes[name], [field]: value },
      },
    });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(fromDraft(draft));
  };

  const apply = (suggestion: ResourceSuggestion) => {
    if (suggestion.kind === 'profile') {
      setProfileSize.mutate({
        profileId: suggestion.profileId,
        size: suggestion.to,
      });
      return;
    }
    const field = suggestion.kind === 'reserve' ? 'reserveMb' : 'memoryMb';
    const sizes = {
      ...data.settings.sizes,
      [suggestion.size]: {
        ...data.settings.sizes[suggestion.size],
        [field]: suggestion.to,
      },
    };
    save.mutate({ ...data.settings, sizes });
  };

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-base font-semibold">Recursos dos agentes</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Cada agente roda num container com CPU e memória do seu tamanho, e uma etapa só começa quando a reserva dele cabe no que sobra da
          máquina depois do Studio. Assim os agentes nunca tomam a máquina inteira. Mudanças valem na hora, também para os agentes que já
          estão rodando.
        </p>
      </div>

      {data.machine && data.budget && (
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-panel p-3">
            <div className="text-xs text-muted">Docker</div>
            <div className="mt-1 font-medium">
              {data.machine.cpus} vCPU · {gb(data.machine.memoryMb)}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-panel p-3">
            <div className="text-xs text-muted">Para os agentes</div>
            <div className="mt-1 font-medium">
              {Math.floor(data.budget.cpus)} vCPU · {gb(data.budget.memoryMb)}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-panel p-3">
            <div className="text-xs text-muted">Reservado agora ({data.reserved.agents} agentes)</div>
            <div className="mt-1 font-medium">
              {data.reserved.cpus} vCPU · {gb(data.reserved.memoryMb)}
            </div>
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold">Sugestões do Gestor de Capacidade</h3>
        <p className="mt-1 text-xs text-muted">
          Pelo que os agentes usaram nos últimos {data.windowDays} dias (pico de memória e CPU, medidos a cada minuto).
        </p>
        {data.suggestions.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            Nenhuma sugestão: os tamanhos estão de acordo com o uso medido (ou ainda falta medição).
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
            {data.suggestions.map((suggestion) => (
              <li key={suggestionTitle(suggestion)} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{suggestionTitle(suggestion)}</div>
                  <div className="text-xs text-muted">{suggestion.reason}</div>
                </div>
                {isAdmin && (
                  <Button type="button" disabled={save.isPending || setProfileSize.isPending} onClick={() => apply(suggestion)}>
                    Aplicar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border bg-panel p-4 text-sm">
        <fieldset disabled={!isAdmin} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="CPU para o Studio (vCPU)" hint="Fica fora do orçamento dos agentes.">
              <TextInput
                inputMode="decimal"
                value={draft.reservedCpus}
                onChange={(event) => setDraft({ ...draft, reservedCpus: event.target.value })}
              />
            </Field>
            <Field label="Memória para o Studio (GB)" hint="Studio, Postgres, n8n, proxy e o Windows.">
              <TextInput
                inputMode="decimal"
                value={draft.reservedMemoryGb}
                onChange={(event) => setDraft({ ...draft, reservedMemoryGb: event.target.value })}
              />
            </Field>
            <Field label="Folga de CPU (×)" hint="Agentes passam muito tempo esperando o modelo: a CPU pode ser reservada mais de uma vez.">
              <TextInput
                inputMode="decimal"
                value={draft.cpuOvercommit}
                onChange={(event) => setDraft({ ...draft, cpuOvercommit: event.target.value })}
              />
            </Field>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">Tamanho</th>
                  <th className="py-1 pr-3 font-medium">vCPU</th>
                  <th className="py-1 pr-3 font-medium">Memória máx. (GB)</th>
                  <th className="py-1 pr-3 font-medium">Reserva (GB)</th>
                  <th className="py-1 font-medium">Uso medido</th>
                </tr>
              </thead>
              <tbody>
                {data.sizes.map((size) => (
                  <tr key={size.name} className="border-t border-border align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{size.name}</div>
                      <div className="text-xs text-muted">{sizeHint[size.name]}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <TextInput
                        className="w-20"
                        inputMode="decimal"
                        value={draft.sizes[size.name].cpus}
                        onChange={(event) => setSize(size.name, 'cpus', event.target.value)}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <TextInput
                        className="w-24"
                        inputMode="decimal"
                        value={draft.sizes[size.name].memoryGb}
                        onChange={(event) => setSize(size.name, 'memoryGb', event.target.value)}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <TextInput
                        className="w-24"
                        inputMode="decimal"
                        value={draft.sizes[size.name].reserveGb}
                        onChange={(event) => setSize(size.name, 'reserveGb', event.target.value)}
                      />
                    </td>
                    <td className="py-2 text-xs text-muted">{usageText(size.usage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </fieldset>
        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={!changed || save.isPending}>
              {save.isPending ? 'Salvando…' : 'Salvar'}
            </Button>
            {changed && (
              <Button type="button" onClick={() => setDraft(toDraft(data.settings))}>
                Desfazer
              </Button>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted">Só administradores mudam os recursos.</p>
        )}
        <ErrorText error={save.error} />
      </form>

      <p className="text-xs text-muted">
        O tamanho de cada agente fica na aba Agentes do workspace dele (automático pelo papel: backend G, front e testes M, o resto P).
      </p>
    </section>
  );
}
