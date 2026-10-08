import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { config } from '../../config.js';
import { createContainer, removeContainer, startContainer, stopContainer } from '../../lib/docker.js';
import { workdirHostPath } from './workdir.js';

export const AGENT_LABEL = 'agents-manager-studio.agent-id';

export function agentVolumeName(agentId: string) {
  return `ams-agent-${agentId}`;
}

export function hashSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

function systemPromptAppend(branch: string, baseBranch: string) {
  return [
    'Você é um agente de programação gerenciado pelo Agents Manager Studio.',
    `- Você trabalha em /workspace, uma cópia isolada do projeto na branch "${branch}", criada a partir de "${baseBranch}".`,
    '- NÃO faça commit, push, nem crie ou troque de branch: o usuário revisa o diff no Studio e conclui por lá.',
    '- O ambiente tem Node.js 24, Python 3 (pip e venv) e git, sem sudo. Instale dependências no projeto (npm install, ou python -m venv .venv) e rode os testes antes de terminar. Não versione a pasta .venv.',
    '- Quando precisar de uma decisão do usuário, use a ferramenta AskUserQuestion em vez de supor.',
    '- Ao terminar, resuma o que foi feito e o que o usuário deve revisar.',
    '- Responda em português.',
  ].join('\n');
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
  agent: { id: string; model: string; workdir: string; branch: string; baseBranch: string; sessionId: string | null };
  claudeToken: string;
  skillIds: string[];
}

/** Starts the runner container; the returned secret hash authenticates its calls to the server. */
export async function startAgentContainer({ agent, claudeToken, skillIds }: StartAgentInput) {
  const secret = randomBytes(24).toString('base64url');
  const shortId = agent.id.slice(-8);

  const containerId = await createContainer({
    image: config.agentRunnerImage,
    name: `ams-agent-${shortId}-${Date.now().toString(36)}`,
    cmd: ['node', '/opt/runner/src/runner.mjs'],
    network: config.agentNetwork,
    labels: { [AGENT_LABEL]: agent.id },
    binds: [
      `${workdirHostPath(agent.workdir)}:/workspace`,
      `${agentVolumeName(agent.id)}:/home/node/.claude`,
      ...skillBinds(skillIds),
    ],
    env: {
      AGENT_ID: agent.id,
      AGENT_SECRET: secret,
      SERVER_URL: config.serverInternalUrl,
      MODEL: agent.model,
      IDLE_TIMEOUT_MS: String(config.agentIdleTimeoutMs),
      SYSTEM_PROMPT_APPEND: systemPromptAppend(agent.branch, agent.baseBranch),
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
      ...(agent.sessionId && { RESUME_SESSION_ID: agent.sessionId }),
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
