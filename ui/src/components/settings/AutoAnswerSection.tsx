import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { ErrorText, Field, Select } from '../form';

const OPTIONS = [null, 15, 30, 60, 120, 240] as const;

/** Questions left unanswered for this long are answered by the Studio with the recommended option. */
export function AutoAnswerSection() {
  const queryClient = useQueryClient();
  const setting = useQuery({ queryKey: ['auto-answer'], queryFn: () => api.get<{ minutes: number | null }>('/auto-answer') });
  const update = useMutation({
    mutationFn: (minutes: number | null) => api.put<{ minutes: number | null }>('/auto-answer', { minutes }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auto-answer'] }),
  });
  const minutes = setting.data?.minutes ?? null;

  return (
    <section>
      <h2 className="text-base font-semibold">Respostas automáticas</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Quando um agente te faz uma pergunta e você não responde neste tempo, o Studio responde por você com a opção que o agente marcou como
        recomendada (nas aprovações, &quot;Aprovar&quot;), e o trabalho segue. Fica registrado na conversa do agente, para você revisar quando voltar.
      </p>
      <div className="mt-4 max-w-xs">
        <Field label="Responder sozinho depois de">
          <Select
            value={minutes ?? ''}
            onChange={(event) => update.mutate(event.target.value ? Number(event.target.value) : null)}
            disabled={setting.isPending || update.isPending}
          >
            {OPTIONS.map((option) => (
              <option key={option ?? 'off'} value={option ?? ''}>
                {option === null ? 'Desligado (sempre esperar por mim)' : option < 60 ? `${option} minutos` : `${option / 60} hora(s)`}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ErrorText error={setting.error ?? update.error} />
    </section>
  );
}
