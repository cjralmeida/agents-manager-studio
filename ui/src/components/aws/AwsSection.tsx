import { Link } from 'react-router';
import { useAwsAccounts, useAwsSettings, useSetWorkspaceAwsAccount } from '../../api/aws';
import type { WorkspaceDetail } from '../../api/workspaces';
import { ErrorText, Select } from '../form';

/**
 * The workspace's AWS account (its own account in the Organization, with the Studio's IAM user). Where each project
 * runs is set in the Deploys tab.
 */
export function AwsSection({ workspace }: { workspace: WorkspaceDetail }) {
  const accounts = useAwsAccounts();
  const settings = useAwsSettings(workspace.id);
  const setAccount = useSetWorkspaceAwsAccount(workspace.id);
  const connection = settings.data?.connection;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Cada workspace usa uma conta própria da AWS, criada na sua Organization, com um usuário IAM só para o Studio.{' '}
        <Link to="/guia/aws" className="text-accent hover:underline">
          Passo a passo para criar a conta e o usuário
        </Link>
        . Depois de escolher a conta, configure o deploy de cada projeto na aba Deploys: o Studio cria e configura o resto.
      </p>
      {accounts.data?.length === 0 ? (
        <p className="text-sm text-muted">
          Cadastre a chave do usuário IAM na página{' '}
          <Link to="/connectors" className="text-accent hover:underline">
            Conectores
          </Link>
          .
        </p>
      ) : (
        <div className="max-w-md">
          <Select value={connection?.accountId ?? ''} onChange={(event) => setAccount.mutate(event.target.value || null)} disabled={setAccount.isPending}>
            <option value="">Nenhuma (sem deploy na AWS)</option>
            {accounts.data?.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label} ({account.region})
              </option>
            ))}
          </Select>
        </div>
      )}
      <ErrorText error={setAccount.error ?? settings.error} />
    </div>
  );
}
