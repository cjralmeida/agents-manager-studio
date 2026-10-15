import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { config } from '../../config.js';
import { type ContainerMount, createContainer, removeContainer, startContainer, stopContainer } from '../../lib/docker.js';
import { AGENT_VARIABLES_FILE, variablesSubpath } from '../agent-variables/service.js';
import { ORBI_GUIDE } from '../assistant/guide.js';
import { buildDirBinds } from './build-dirs.js';
import { workdirMount } from './workdir.js';

export const AGENT_LABEL = 'agents-manager-studio.agent-id';

/** Docker volume with the package caches every agent shares. */
export const AGENT_CACHE_VOLUME = 'ams-agent-cache';

export function agentVolumeName(agentId: string) {
  return `ams-agent-${agentId}`;
}

export function hashSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

export interface RuntimeAgent {
  id: string;
  kind: 'TASK' | 'ASSISTANT';
  model: string;
  workdir: string;
  branch: string;
  baseBranch: string;
  sessionId: string | null;
  projectId: string | null;
  output: 'PULL_REQUEST' | 'RESULT';
  autoConclude: boolean;
  instructions: string;
  tools: string[];
}

/** Studio tools the runner exposes: the enabled groups, plus result reporting for agents that deliver a result. */
export function runnerTools(agent: Pick<RuntimeAgent, 'tools' | 'output' | 'kind'>) {
  return [...new Set([...agent.tools, ...(agent.output === 'RESULT' || agent.kind === 'TASK' ? ['result'] : [])])];
}

export const TIME_NOTE = '- Horários: o usuário está no fuso America/Sao_Paulo (UTC−3), e este container também (TZ). As ferramentas e as APIs do Studio devolvem horários em UTC (ISO terminando em Z): converta para o horário de Brasília antes de mostrar ao usuário ou de escrever em tarefas e relatórios (ex.: 17:44Z → 14:44).';

function systemPromptAppend(agent: RuntimeAgent, variableNames: string[] | null, contextProjects: ContextProject[] = []) {
  // Órbi has its own guide (always the current version, also for resumed conversations).
  if (agent.kind === 'ASSISTANT') return ORBI_GUIDE;
  const tools = runnerTools(agent);
  const lines = ['Você é um agente gerenciado pelo Agents Manager Studio.', TIME_NOTE];

  if (agent.projectId) {
    lines.push(`- Você trabalha em /workspace, uma cópia isolada do projeto na branch "${agent.branch}", criada a partir de "${agent.baseBranch}".`);
    lines.push('- NÃO faça commit, push, nem crie ou troque de branch.');
  } else {
    lines.push('- Você não trabalha em um repositório: /workspace é uma pasta de trabalho temporária.');
  }

  if (agent.output === 'RESULT') {
    lines.push('- Sua entrega não é código. Ao terminar, chame a ferramenta studio_report_result com o status (success ou failure) e um resumo claro do resultado.');
  } else if (agent.autoConclude) {
    lines.push('- Quando você terminar, o Studio faz o commit e abre o PR/MR automaticamente com as suas alterações (ou atualiza o PR/MR que já existe nesta branch).');
  } else {
    lines.push('- O usuário revisa o diff no Studio e conclui por lá.');
  }

  if (agent.output !== 'RESULT' && tools.includes('result')) {
    lines.push(
      '- Antes de terminar, você pode chamar studio_report_result: o resumo e os detalhes vão para o próximo passo do workflow. Use status "failure" para reprovar o trabalho (o workflow devolve a quem fez) e "success" no caso contrário.',
    );
  }

  if (tools.includes('board')) {
    lines.push(
      '- Use as ferramentas studio_board_* para consultar, criar e atualizar tarefas no quadro de tarefas do workspace.',
      '- A coluna Backlog é só para o que ainda não foi decidido: uma tarefa que espera uma decisão entre um agente e o usuário (uma dúvida que você não pode resolver sozinho) vai para lá com o campo Decisão = "Aguardando decisão" — um agente é chamado para decidir com o usuário; quem decide limpa o campo (fields {"Decisão": ""}). Uma tarefa decidida que espera outras fica em "A fazer" com a linha "Depende de: repo#N": os agentes só a pegam quando as dependências forem entregues.',
    );
  }
  if (tools.includes('projects')) {
    lines.push(
      '- Use studio_project_owners e studio_project_create para criar o repositório de um projeto novo (privado), SEMPRE depois de o usuário confirmar o nome e o lugar (AskUserQuestion). Para trabalhar num projeto que já existe (ex.: revisar um jogo), use studio_project_use: os próximos passos do workflow trabalham nele.',
    );
  }
  if (tools.includes('clickup_read')) {
    lines.push('- Use studio_clickup_hierarchy, studio_clickup_list_tasks e studio_clickup_get_task para LER tarefas do ClickUp (somente leitura; nada é alterado lá).');
  }
  if (tools.includes('test_env')) {
    lines.push(
      '- Use studio_test_env_start / studio_test_env_status / studio_test_env_stop para subir um ambiente de teste local do projeto (Docker) quando a homologação não estiver utilizável; ele só sobe se houver memória livre no computador. Derrube-o ao terminar.',
    );
  }
  if (tools.includes('pixellab')) {
    lines.push('- Você tem as ferramentas do PixelLab (servidor MCP "pixellab") para gerar e animar pixel art. Elas custam créditos do usuário: use-as só como a sua skill indica.');
  }
  if (tools.includes('render_read') && !tools.includes('render')) {
    lines.push('- Use studio_render_environments para as URLs de homologação dos projetos e studio_render_logs para os logs deles (só leitura).');
  }
  if (tools.includes('render')) {
    lines.push(
      '- Use as ferramentas studio_render_* para o serviço de HOMOLOGAÇÃO do projeto no Render. Alterações que você fizer na cópia são publicadas por studio_render_deploy (o Studio faz commit, PR/MR e merge); depois do último deploy, não deixe alterações sem publicar.',
    );
  }
  lines.push(
    '- O ambiente tem Node.js 24, Python 3 (pip e venv), Go 1.25, Java 21 com Maven (Java 11 em /opt/java/jdk11: use JAVA_HOME=/opt/java/jdk11 em projetos Java 8 a 11), psql e git, sem sudo. Instale dependências no projeto (npm install, python -m venv .venv, go mod download, mvn ...) e rode os testes antes de terminar. Não versione .venv nem pastas de build.',
    '- Quando precisar de uma decisão do usuário, use a ferramenta AskUserQuestion em vez de supor. Ponha "(Recomendado)" no rótulo da opção que você recomenda (em pedidos de aprovação, a opção "Aprovar"): se o usuário não responder a tempo, o Studio responde por ele com essa opção.',
    '- Seu trabalho termina quando o seu turno termina: não deixe nada rodando em segundo plano. Se usar subagentes, espere todos terminarem e confira o que fizeram antes de encerrar.',
    '- Ao terminar, resuma o que foi feito.',
    '- Responda em português.',
  );
  if (agent.projectId) {
    lines.push(
      '- Para testes que precisam de banco, use SOMENTE TEST_DATABASE_URL (PostgreSQL exclusivo desta execução) e, se precisar de Redis, TEST_REDIS_URL. Nunca use outro banco ou serviço real nos testes. Se TEST_DATABASE_BASELINE estiver definida, o banco já vem com o baseline do projeto aplicado (os .sql dessa pasta): não aplique de novo, só o que vier depois dele (ex.: migrações novas ao subir a aplicação). Sem ela, o banco começa vazio.',
    );
  }
  if (contextProjects.length > 0) {
    lines.push(
      '- Projetos de consulta, SOMENTE LEITURA (a pasta local como está no disco, incluindo arquivos fora do git): ' +
        contextProjects
          .map((project) => {
            const branch = project.branch ? `branch atual "${project.branch}"` : 'sem git';
            const warning = project.baseBranch && project.branch && project.branch !== project.baseBranch ? `; ATENÇÃO: a branch base do projeto é "${project.baseBranch}"` : '';
            return `${contextMount(project.name)} (${branch}${warning})`;
          })
          .join(', ') +
        '. Leia à vontade (git log/show/diff funcionam); não tente gravar nelas.',
    );
  }
  if (variableNames) {
    lines.push(
      `- Variáveis do workspace (ex.: credenciais de teste) ficam em ${AGENT_VARIABLES_FILE}: no shell, carregue com \`set -a; . ${AGENT_VARIABLES_FILE}; set +a\` no mesmo comando que as usa; em código (Node, Python, testes), leia /run/studio/variables.json (objeto nome → valor). Nunca leia o .env como texto: os valores dele estão entre aspas de shell. Nomes atuais: ${variableNames.join(', ') || 'nenhuma'}. Se faltar alguma, peça ao usuário (AskUserQuestion) para cadastrá-la no Studio (workspace → Configuração → Variáveis dos agentes) e carregue o arquivo de novo depois da resposta. Nunca imprima os valores.`,
    );
  }
  if (agent.instructions.trim()) lines.push('', 'Seu papel neste workspace:', agent.instructions.trim());
  return lines.join('\n');
}

/** Each enabled skill is mounted read-only under ~/.claude/skills; names are made unique. */
function skillBinds(skillIds: string[]) {
  const used = new Set<string>();
  return skillIds.map((id) => {
    let name = path.posix.basename(id);
    while (used.has(name)) name = `${name}-${used.size}`;
    used.add(name);
    return `${config.skillsHostDir}/${id}:/home/node/.claude/skills/${name}:ro`;
  });
}

export interface StartAgentInput {
  agent: RuntimeAgent;
  claudeToken: string;
  skillIds: string[];
  /** Extra variables, e.g. the URLs of the throwaway test database and Redis. */
  env?: Record<string, string>;
  /** Names in the workspace variables file mounted at /run/studio (null: no file, e.g. Órbi). */
  variableNames?: string[] | null;
  /** Projects mounted read-only at /context/<name>, as they are on disk. */
  contextProjects?: ContextProject[];
}

export interface ContextProject {
  name: string;
  hostPath: string;
  /** Folder inside the agents volume holding the project's checkout (null: mounted from the Windows folder). */
  volumeSubpath?: string | null;
  /** Branch checked out in the folder (null: not a git repository). */
  branch: string | null;
  /** The project's base branch, when set (warned about when the folder is on another one). */
  baseBranch: string | null;
}

/** Folder names are safe for a mount path; anything else is replaced. */
const contextMount = (name: string) => `/context/${name.replace(/[^\w.-]/g, '_')}`;

/** Starts the runner container; the returned secret hash authenticates its calls to the server. */
export async function startAgentContainer({ agent, claudeToken, skillIds, env = {}, variableNames = null, contextProjects = [] }: StartAgentInput) {
  const secret = randomBytes(24).toString('base64url');
  const shortId = agent.id.slice(-8);
  const buildBinds = await buildDirBinds(agent).catch(() => []);

  const containerId = await createContainer({
    image: config.agentRunnerImage,
    name: `ams-agent-${shortId}-${Date.now().toString(36)}`,
    cmd: ['node', '/opt/runner/src/runner.mjs'],
    network: config.agentNetwork,
    labels: { [AGENT_LABEL]: agent.id },
    mounts: [
      workdirMount(agent.workdir, '/workspace'),
      ...(variableNames ? [{ Type: 'volume' as const, Source: config.agentsVolume, Target: '/run/studio', ReadOnly: true, VolumeOptions: { Subpath: variablesSubpath(agent.id) } }] : []),
      ...contextProjects.flatMap((project): ContainerMount[] =>
        project.volumeSubpath
          ? [{ Type: 'volume', Source: config.agentsVolume, Target: contextMount(project.name), ReadOnly: true, VolumeOptions: { Subpath: project.volumeSubpath } }]
          : [],
      ),
    ],
    binds: [
      `${agentVolumeName(agent.id)}:/home/node/.claude`,
      // Package caches shared by all agents (npm, pnpm, Maven, Go, pip...): see the agent-runner Dockerfile.
      `${AGENT_CACHE_VOLUME}:/cache`,
      // node_modules, target... in Docker volumes: much faster than through the Windows folder (see build-dirs.ts).
      ...buildBinds,
      ...skillBinds(skillIds),
      ...contextProjects.filter((project) => !project.volumeSubpath).map((project) => `${project.hostPath}:${contextMount(project.name)}:ro`),
    ],
    env: {
      AGENT_ID: agent.id,
      AGENT_SECRET: secret,
      SERVER_URL: config.serverInternalUrl,
      MODEL: agent.model,
      IDLE_TIMEOUT_MS: String(config.agentIdleTimeoutMs),
      SYSTEM_PROMPT_APPEND: systemPromptAppend(agent, variableNames, contextProjects),
      STUDIO_TOOLS: runnerTools(agent).join(','),
      // An agent's work ends with its turn (the Studio concludes it then): nothing may keep running in the
      // background, or it would be killed with the container (e.g. subagents creating tasks).
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      // The user's time zone: `date`, logs and the agent's own notes show local time, like the Studio.
      TZ: process.env.TZ || 'America/Sao_Paulo',
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
      ...(agent.sessionId && { RESUME_SESSION_ID: agent.sessionId }),
      // Reference folders belong to the host user: git would refuse them as "dubious ownership".
      ...(contextProjects.length > 0 && { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }),
      ...env,
    },
  });

  try {
    await startContainer(containerId);
  } catch (error) {
    await removeContainer(containerId).catch(() => undefined);
    throw error;
  }
  return { containerId, secretHash: hashSecret(secret) };
}

export async function stopAgentContainer(containerId: string) {
  await stopContainer(containerId, 15);
  await removeContainer(containerId);
}
