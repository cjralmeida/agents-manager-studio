import { type FormEvent, useEffect, useState } from 'react';
import { type BoardWebhook, useSaveWebhookUrl, useSetupWebhooks, useWebhooks } from '../../api/webhooks';
import { timeAgo } from '../../lib/time';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';

const scopeLabel: Record<NonNullable<NonNullable<BoardWebhook['webhook']>['scope']>, string> = {
  organization: 'na organização',
  group: 'no grupo',
  projects: 'em cada projeto do grupo',
};

/**
 * Git webhooks through the Cloudflare Tunnel: with the public address saved, the Studio sets up the hook of every
 * linked board (and of each board linked later), and boards are read again as soon as a task changes.
 */
export function WebhooksSection() {
  const webhooks = useWebhooks();
  const save = useSaveWebhookUrl();
  const setup = useSetupWebhooks();
  const [publicUrl, setPublicUrl] = useState('');
  const data = webhooks.data;

  useEffect(() => {
    setPublicUrl(data?.publicUrl ?? '');
  }, [data?.publicUrl]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(publicUrl.trim() || null);
  };

  return (
    <section>
      <h2 className="text-base font-semibold">Webhooks dos quadros</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Com o endereço público do túnel (Cloudflare Tunnel), o GitLab e o GitHub avisam o Studio quando uma tarefa muda, e o quadro é lido na hora em
        vez de esperar a próxima leitura. O Studio cadastra o webhook de cada quadro sozinho, também nos quadros vinculados depois. Pelo túnel só
        passam os webhooks.
      </p>
      <ErrorText error={webhooks.error} />

      <form onSubmit={handleSubmit} className="mt-4 space-y-3 rounded-lg border border-border bg-panel p-4 text-sm">
        <Field label="Endereço público do túnel" hint="O hostname público configurado no Cloudflare, como https://webhooks.seudominio.com.">
          <TextInput value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} placeholder="https://webhooks.seudominio.com" spellCheck={false} />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={save.isPending || (publicUrl.trim() || null) === (data?.publicUrl ?? null)}>
            {save.isPending ? 'Configurando os quadros…' : 'Salvar e configurar os quadros'}
          </Button>
          {data?.publicUrl && (
            <Button type="button" disabled={setup.isPending} onClick={() => setup.mutate()}>
              {setup.isPending ? 'Configurando…' : 'Configurar de novo'}
            </Button>
          )}
          {data?.lastDelivery ? (
            <span className="text-xs text-muted">
              Último aviso: {timeAgo(data.lastDelivery.at)} ({data.lastDelivery.provider === 'GITHUB' ? 'GitHub' : 'GitLab'}
              {data.lastDelivery.owner ? `, ${data.lastDelivery.owner}` : ''})
            </span>
          ) : (
            data?.publicUrl && <span className="text-xs text-muted">Nenhum aviso recebido ainda.</span>
          )}
        </div>
        <ErrorText error={save.error ?? setup.error} />
      </form>

      {data && data.boards.length > 0 && (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border text-sm">
          {data.boards.map((board) => (
            <li key={board.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 p-3">
              <div className="min-w-0 flex-1">
                <a href={board.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                  {board.title}
                </a>
                <span className="ml-2 text-xs text-muted">
                  {board.workspace} · {board.provider === 'GITHUB' ? 'GitHub' : 'GitLab'} · {board.ownerPath}
                </span>
                {board.webhook?.error && <p className="mt-1 text-xs text-amber-300">{board.webhook.error}</p>}
              </div>
              {!board.webhook ? (
                <Badge>{data.publicUrl ? 'Configurando' : 'Sem endereço'}</Badge>
              ) : board.webhook.ok ? (
                <Badge tone="success">Ativo {board.webhook.scope ? scopeLabel[board.webhook.scope] : ''}</Badge>
              ) : (
                <Badge tone="warning">Leitura periódica</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
