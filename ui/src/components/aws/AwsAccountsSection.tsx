import { type FormEvent, useState } from 'react';
import { type AwsAccount, useAwsAccounts, useCreateAwsAccount, useDeleteAwsAccount, useVerifyAwsAccount } from '../../api/aws';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ErrorText, Field, TextInput } from '../form';

/** Global AWS accounts (an IAM user's access key); each workspace picks one in its Conectores tab. */
export function AwsAccountsSection() {
  const accounts = useAwsAccounts();
  return (
    <section>
      <h2 className="text-base font-semibold">Contas da AWS</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Chave de acesso de um usuário IAM só para os deploys (nunca a da conta principal). O segredo fica criptografado e
        nunca vai para os agentes. Depois, na aba Conectores de cada workspace, escolha a conta e diga onde cada projeto
        roda: um EC2 (backend, imagem pelo Dockerfile) ou um app do Amplify (frontend).
      </p>
      <ErrorText error={accounts.error} />
      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {accounts.data?.map((account) => <AwsAccountItem key={account.id} account={account} />)}
        {accounts.data?.length === 0 && <li className="px-4 py-3 text-sm text-muted">Nenhuma conta cadastrada.</li>}
      </ul>
      <NewAwsAccountForm />
    </section>
  );
}

function AwsAccountItem({ account }: { account: AwsAccount }) {
  const remove = useDeleteAwsAccount();
  const verify = useVerifyAwsAccount();
  const handleRemove = () => {
    const usage = account.workspaceCount > 0 ? ` ${account.workspaceCount} workspace(s) ficarão sem deploy na AWS.` : '';
    if (window.confirm(`Remover a conta "${account.label}"?${usage}`)) remove.mutate(account.id);
  };
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">AWS</Badge>
        <span className="font-medium">{account.label}</span>
        <span className="text-xs text-muted">
          conta {account.awsAccountNumber} · {account.region}
        </span>
        <span className="font-mono text-xs text-muted" title={account.identityArn}>
          {account.accessKeyId}
        </span>
        <span className="text-xs text-muted">· {account.workspaceCount} workspace(s)</span>
      </div>
      <div className="flex items-center gap-2">
        {verify.isSuccess && <span className="text-xs text-emerald-300">Chave ok</span>}
        <Button size="sm" onClick={() => verify.mutate(account.id)} disabled={verify.isPending}>
          Testar
        </Button>
        <Button size="sm" variant="danger" onClick={handleRemove} disabled={remove.isPending}>
          Remover
        </Button>
      </div>
      <ErrorText error={verify.error ?? remove.error} />
    </li>
  );
}

function NewAwsAccountForm() {
  const create = useCreateAwsAccount();
  const [label, setLabel] = useState('');
  const [region, setRegion] = useState('sa-east-1');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { label, region, accessKeyId, secretAccessKey },
      {
        onSuccess: () => {
          setLabel('');
          setAccessKeyId('');
          setSecretAccessKey('');
        },
      },
    );
  };
  return (
    <form onSubmit={submit} className="mt-4 grid max-w-3xl gap-3 sm:grid-cols-2">
      <Field label="Nome">
        <TextInput value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ex.: AWS GlobalFarm HOM" required />
      </Field>
      <Field label="Região" hint="Onde ficam o EC2, o ECR e o Amplify (ex.: sa-east-1, us-east-1).">
        <TextInput value={region} onChange={(event) => setRegion(event.target.value)} required />
      </Field>
      <Field label="Access key ID">
        <TextInput value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} autoComplete="off" required />
      </Field>
      <Field label="Secret access key">
        <TextInput type="password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} autoComplete="new-password" required />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? 'Conferindo a chave...' : 'Adicionar conta'}
        </Button>
        <ErrorText error={create.error} />
      </div>
    </form>
  );
}
