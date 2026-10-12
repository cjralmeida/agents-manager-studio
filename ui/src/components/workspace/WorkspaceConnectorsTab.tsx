import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  type AccountGitProvider,
  useAgentAccounts,
  useGitAccounts,
} from "../../api/accounts";
import { useBoardSources } from "../../api/boards";
import { useClickupAccounts } from "../../api/clickup";
import { usePixellabAccounts } from "../../api/pixellab";
import { useRenderAccounts } from "../../api/render";
import {
  type WorkspaceSettings,
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from "../../api/workspaceSettings";
import type { WorkspaceDetail } from "../../api/workspaces";
import { remoteHost } from "../../lib/git";
import { Badge } from "../Badge";
import { Logo } from "../Logo";
import { BoardConnection } from "../board/BoardLinkSection";
import { type ConnectorId, ConnectorIcon } from "../connectors/ConnectorIcon";
import { ErrorText, Select } from "../form";
import { MultiSelect } from "../MultiSelect";
import { RenderSection } from "../render/RenderSection";

function ConnectorCard({
  icon,
  name,
  purpose,
  connected,
  children,
}: {
  icon: ReactNode;
  name: string;
  purpose: string;
  connected: boolean;
  children: ReactNode;
}) {
  return (
    <article className="flex flex-col rounded-xl border border-border bg-panel p-4">
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">{name}</h2>
            {connected ? (
              <Badge tone="success">Disponível</Badge>
            ) : (
              <Badge>Desligado</Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted">{purpose}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </article>
  );
}

const noAccountsLink = (
  <Link to="/connectors" className="text-accent hover:underline">
    Conecte uma conta em Conectores
  </Link>
);

/** Which connected tools this workspace's agents can use, and the per-workspace parts (board, Render). */
export function WorkspaceConnectorsTab({
  workspace,
}: {
  workspace: WorkspaceDetail;
}) {
  const settings = useWorkspaceSettings(workspace.id);
  const agentAccounts = useAgentAccounts();
  const gitAccounts = useGitAccounts();
  const boardSources = useBoardSources(workspace.id);
  const renderAccounts = useRenderAccounts();
  const clickupAccounts = useClickupAccounts();
  const pixellabAccounts = usePixellabAccounts();
  const update = useUpdateWorkspaceSettings(workspace.id);

  const error =
    settings.error ??
    agentAccounts.error ??
    gitAccounts.error ??
    renderAccounts.error;
  if (error) return <ErrorText error={error} />;
  if (
    !settings.data ||
    !agentAccounts.data ||
    !gitAccounts.data ||
    !renderAccounts.data
  )
    return <p className="text-sm text-muted">Carregando...</p>;
  const current = settings.data;

  /** Each change is saved right away, keeping the rest of the workspace settings. */
  const save = (patch: Partial<WorkspaceSettings>) =>
    update.mutate({ ...current, ...patch });

  const projectHosts = (provider: AccountGitProvider) => [
    ...new Set(
      workspace.projects
        .filter(
          (project) =>
            !project.isMissing &&
            project.gitProvider === provider &&
            project.gitRemoteUrl,
        )
        .map((project) => remoteHost(project.gitRemoteUrl ?? ""))
        .filter((host): host is string => host !== null),
    ),
  ];

  const gitCard = (
    provider: AccountGitProvider,
    id: ConnectorId,
    name: string,
    purpose: string,
  ) => {
    const accounts = gitAccounts.data!.filter(
      (account) => account.provider === provider,
    );
    const selected = accounts.filter((account) =>
      current.gitAccountIds.includes(account.id),
    );
    const hosts = projectHosts(provider);
    const otherProviders = current.gitAccountIds.filter(
      (id) => !accounts.some((account) => account.id === id),
    );

    return (
      <ConnectorCard
        icon={<ConnectorIcon id={id} />}
        name={name}
        purpose={purpose}
        connected={selected.length > 0}
      >
        {accounts.length === 0 ? (
          <p className="text-sm text-muted">{noAccountsLink}.</p>
        ) : (
          <MultiSelect
            options={accounts.map((account) => ({
              value: account.id,
              label: account.label,
              detail: `@${account.username} · ${account.host}`,
            }))}
            selected={selected.map((account) => account.id)}
            onChange={(ids) =>
              save({ gitAccountIds: [...otherProviders, ...ids] })
            }
            placeholder="Nenhuma (sem acesso)"
            disabled={update.isPending}
          />
        )}
        {hosts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
            <span className="text-muted">Projetos em:</span>
            {hosts.map((host) => {
              const covered = selected.some((account) => account.host === host);
              return (
                <Badge key={host} tone={covered ? "success" : "warning"}>
                  {host} {covered ? "✓" : "— sem conta"}
                </Badge>
              );
            })}
          </div>
        )}
      </ConnectorCard>
    );
  };

  return (
    <div className="max-w-6xl space-y-4">
      <p className="max-w-3xl text-sm text-muted">
        Escolha quais ferramentas os agentes deste workspace podem usar. As
        contas são conectadas na página{" "}
        <Link to="/connectors" className="text-accent hover:underline">
          Conectores
        </Link>
        ; o agente usa a conta git do mesmo host do repositório, por isso uma
        conta por host.
      </p>
      <ErrorText error={update.error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ConnectorCard
          icon={<ConnectorIcon id="claude" />}
          name="Claude"
          purpose="Conta usada pelos agentes e pelo Órbi neste workspace."
          connected={Boolean(current.agentAccountId)}
        >
          {agentAccounts.data.length === 0 ? (
            <p className="text-sm text-muted">{noAccountsLink}.</p>
          ) : (
            <Select
              value={current.agentAccountId ?? ""}
              onChange={(event) =>
                save({ agentAccountId: event.target.value || null })
              }
              disabled={update.isPending}
            >
              <option value="">Nenhuma (agentes desligados)</option>
              {agentAccounts.data.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} ({account.tokenHint})
                </option>
              ))}
            </Select>
          )}
        </ConnectorCard>

        {gitCard(
          "GITHUB",
          "github",
          "GitHub",
          "Push, pull requests e quadros do GitHub Projects.",
        )}
        {gitCard(
          "GITLAB",
          "gitlab",
          "GitLab",
          "Push, merge requests e boards de grupo do GitLab.",
        )}

        <ConnectorCard
          icon={
            boardSources.data?.length === 1 &&
            boardSources.data[0]!.provider === "STUDIO" ? (
              <span className="inline-flex size-10 items-center justify-center">
                <Logo size={40} />
              </span>
            ) : boardSources.data?.length === 1 ? (
              <ConnectorIcon
                id={
                  boardSources.data[0]!.provider === "GITHUB"
                    ? "github"
                    : "gitlab"
                }
              />
            ) : (
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-border text-lg">
                ▦
              </span>
            )
          }
          name="Quadro de tarefas"
          purpose="Onde ficam as tarefas que os agentes e workflows pegam e movimentam. Pode juntar quadros do GitHub, do GitLab e do Studio."
          connected={(boardSources.data?.length ?? 0) > 0}
        >
          <BoardConnection workspaceId={workspace.id} />
        </ConnectorCard>

        <div className="lg:col-span-2">
          <ConnectorCard
            icon={<ConnectorIcon id="clickup" />}
            name="ClickUp"
            purpose="Conta de onde os agentes leem tarefas (somente leitura), com a ferramenta 'ClickUp (leitura)'."
            connected={Boolean(current.clickupAccountId)}
          >
            {(clickupAccounts.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted">{noAccountsLink}.</p>
            ) : (
              <div className="max-w-md">
                <Select
                  value={current.clickupAccountId ?? ""}
                  onChange={(event) =>
                    save({ clickupAccountId: event.target.value || null })
                  }
                  disabled={update.isPending}
                >
                  <option value="">Nenhuma</option>
                  {clickupAccounts.data!.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label} ({account.username})
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </ConnectorCard>
        </div>

        <div className="lg:col-span-2">
          <ConnectorCard
            icon={<ConnectorIcon id="pixellab" />}
            name="PixelLab"
            purpose="Conta de geração de pixel art para os agentes com a ferramenta 'PixelLab' (gasta créditos)."
            connected={Boolean(current.pixellabAccountId)}
          >
            {(pixellabAccounts.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted">{noAccountsLink}.</p>
            ) : (
              <div className="max-w-md">
                <Select
                  value={current.pixellabAccountId ?? ""}
                  onChange={(event) =>
                    save({ pixellabAccountId: event.target.value || null })
                  }
                  disabled={update.isPending}
                >
                  <option value="">Nenhuma</option>
                  {pixellabAccounts.data!.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label} ({account.tokenHint})
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </ConnectorCard>
        </div>

        <div className="lg:col-span-2">
          <ConnectorCard
            icon={<ConnectorIcon id="render" />}
            name="Render"
            purpose="Deploy em homologação e produção a partir dos workflows."
            connected={Boolean(current.renderAccountId)}
          >
            {renderAccounts.data.length === 0 ? (
              <p className="text-sm text-muted">{noAccountsLink}.</p>
            ) : (
              <div className="space-y-4">
                <div className="max-w-md">
                  <Select
                    value={current.renderAccountId ?? ""}
                    onChange={(event) =>
                      save({ renderAccountId: event.target.value || null })
                    }
                    disabled={update.isPending}
                  >
                    <option value="">Nenhuma (sem deploy)</option>
                    {renderAccounts.data.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.label} ({account.ownerName})
                      </option>
                    ))}
                  </Select>
                </div>
                {current.renderAccountId && (
                  <RenderSection
                    key={current.renderAccountId}
                    workspace={workspace}
                  />
                )}
              </div>
            )}
          </ConnectorCard>
        </div>
      </div>
    </div>
  );
}
