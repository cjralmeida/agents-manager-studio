// Studio tools offered to the agent as an in-process MCP server ("studio").
// Each tool forwards to the Studio server, which runs it with the workspace credentials:
// tokens never enter the container.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/**
 * @param {(name: string, args: object) => Promise<{ ok: boolean, data?: unknown, error?: string }>} call
 * @param {string[]} groups enabled groups: "board" (read and write), "board_read", "result", "render" (homologation), "render_read" (homologation URLs and logs), "studio" (Órbi)
 */
export function createStudioTools(call, groups) {
  const run = (name) => async (args) => {
    const response = await call(name, args);
    if (!response.ok) return { ...asText({ erro: response.error }), isError: true };
    return asText(response.data);
  };

  const tools = [];
  if (groups.includes('result')) {
    tools.push(
      tool(
        'report_result',
        'Registra o resultado final do seu trabalho para o Studio (e para o próximo agente do workflow). Chame uma vez, ao terminar.',
        {
          status: z.enum(['success', 'failure']).describe('success quando o objetivo foi cumprido; failure quando não foi (ex.: testes falharam).'),
          summary: z.string().describe('Resumo claro do resultado, em português.'),
          details: z.string().optional().describe('Detalhes úteis para quem continuar o trabalho (ex.: falhas encontradas e onde).'),
        },
        run('report_result'),
      ),
    );
  }

  const boardRead = groups.includes('board') || groups.includes('board_read');
  if (boardRead) {
    tools.push(
      tool(
        'board_list_tasks',
        'Lista as tarefas do quadro do workspace, com colunas, campos e repositórios disponíveis.',
        {
          column: z.string().optional().describe('Nome da coluna (ex.: "A fazer").'),
          search: z.string().optional().describe('Texto para filtrar por título ou descrição.'),
          limit: z.number().int().optional(),
        },
        run('board_list_tasks'),
      ),
      tool('board_get_task', 'Mostra uma tarefa do quadro com a descrição completa.', { id: z.string() }, run('board_get_task')),
    );
  }
  if (groups.includes('board')) {
    tools.push(
      tool(
        'board_create_task',
        'Cria uma tarefa (issue) no quadro do workspace. Use o modelo de descrição do quadro: Objetivo, Critério de conclusão e Referências.',
        {
          title: z.string(),
          body: z.string().describe('Descrição em Markdown.'),
          repository: z.string().optional().describe('Repositório ou projeto onde a tarefa será feita (veja board_list_tasks).'),
          column: z.string().optional().describe('Coluna inicial; vazio usa a padrão.'),
          fields: z.record(z.string(), z.string()).optional().describe('Campos pelo nome, ex.: {"Tipo": "Bug", "Prioridade": "P2 - Média"}.'),
        },
        run('board_create_task'),
      ),
      tool(
        'board_update_task',
        'Move uma tarefa de coluna, altera seus campos e/ou reescreve título e descrição.',
        {
          id: z.string(),
          title: z.string().optional().describe('Novo título (vazio mantém o atual).'),
          body: z.string().optional().describe('Nova descrição completa, em Markdown (substitui a atual).'),
          column: z.string().optional(),
          fields: z.record(z.string(), z.string()).optional(),
        },
        run('board_update_task'),
      ),
    );
  }

  const renderRead = groups.includes('render') || groups.includes('render_read');
  if (renderRead) {
    tools.push(
      tool(
        'render_environments',
        'Lista os serviços de HOMOLOGAÇÃO de todos os projetos do workspace no Render, com a URL de cada um.',
        {},
        run('render_environments'),
      ),
      tool(
        'render_logs',
        'Últimas linhas de log de um serviço de homologação: "build" (compilação e pré-deploy), "app" (aplicação rodando) ou "request" (requisições HTTP).',
        {
          type: z.enum(['build', 'app', 'request']),
          project: z.string().optional().describe('Nome do projeto (veja render_environments); vazio usa o seu projeto.'),
          limit: z.number().int().optional().describe('Quantidade de linhas (padrão 100, até 300).'),
          text: z.string().optional().describe('Filtra as linhas que contêm este texto.'),
        },
        run('render_logs'),
      ),
    );
  }
  if (groups.includes('render')) {
    tools.push(
      tool(
        'render_service',
        'Mostra o serviço do Render de HOMOLOGAÇÃO do seu projeto: URL, branch publicada, comandos de build/start/pré-deploy, health check, nomes das variáveis de ambiente (sem valores) e os últimos deploys.',
        {},
        run('render_service'),
      ),
      tool(
        'render_set_env_vars',
        'Cria ou altera variáveis de ambiente do serviço de homologação. Use "generate": true para segredos próprios de HOM (o Render gera um valor aleatório que ninguém vê). Nunca invente credenciais de terceiros: pergunte ao usuário. Valem a partir do próximo deploy.',
        {
          vars: z
            .array(
              z.object({
                key: z.string().describe('Nome da variável, ex.: JWT_SECRET.'),
                value: z.string().optional().describe('Valor; omita quando usar generate.'),
                generate: z.boolean().optional().describe('true para o Render gerar um segredo aleatório.'),
              }),
            )
            .describe('Variáveis a gravar.'),
        },
        run('render_set_env_vars'),
      ),
      tool(
        'render_deploy',
        'Publica em homologação: o Studio faz o commit das suas alterações, envia a branch, faz o merge do PR/MR na branch do serviço e pede o deploy ao Render. Devolve o deploymentId.',
        {},
        run('render_deploy'),
      ),
      tool(
        'render_deploy_status',
        'Estado de um deploy de homologação; espera até ele terminar (no máximo waitSeconds, padrão 180, até 240). Chame de novo enquanto finished for false.',
        {
          deploymentId: z.string(),
          waitSeconds: z.number().int().optional(),
        },
        run('render_deploy_status'),
      ),
    );
  }

  if (groups.includes('studio')) {
    tools.push(
      tool(
        'studio_context',
        'Mostra o workspace: projetos, quadro (colunas, campos e opções com ids), Render, agentes e workflows com todos os campos.',
        {},
        run('studio_context'),
      ),
      tool(
        'studio_list_runs',
        'Lista as execuções recentes de workflows, com o estado de cada passo, erros e resumos.',
        { workflowId: z.string().optional(), limit: z.number().int().optional() },
        run('studio_list_runs'),
      ),
      tool(
        'studio_list_executions',
        'Lista as execuções recentes de agentes (opcionalmente de um agente do workspace ou de um status).',
        { agentId: z.string().optional().describe('Id do agente do workspace.'), status: z.string().optional(), limit: z.number().int().optional() },
        run('studio_list_executions'),
      ),
      tool(
        'studio_get_execution',
        'Mostra uma execução com o resultado, o erro e o final da linha do tempo, para explicar o que aconteceu.',
        { id: z.string() },
        run('studio_get_execution'),
      ),
      tool('studio_usage', 'Mostra o consumo do Claude no workspace: limites do plano, custo estimado e tokens.', {}, run('studio_usage')),
      tool(
        'studio_board_options',
        'Procura quadros (GitHub Projects, boards do GitLab) dos repositórios do workspace ainda não vinculados e onde dá para criar um novo. Precisa das contas git do workspace escolhidas.',
        {},
        run('studio_board_options'),
      ),
      tool(
        'studio_render_services',
        'Lista os serviços que a conta do Render do workspace enxerga (id, nome, repositório, branch), para escolher o de cada projeto.',
        {},
        run('studio_render_services'),
      ),
      tool(
        'studio_propose',
        'Propõe uma mudança ao usuário (ele vê um cartão e decide se aplica). O Studio valida antes; se vier erro, corrija o payload.',
        {
          kind: z.enum([
            'create_agent',
            'update_agent',
            'delete_agent',
            'create_workflow',
            'update_workflow',
            'delete_workflow',
            'start_workflow',
            'cancel_run',
            'create_task',
            'update_workspace_settings',
            'create_board',
            'link_board',
            'create_local_board',
            'set_render_service',
          ]),
          summary: z.string().describe('Uma frase dizendo o que a proposta faz, para o cartão.'),
          payload: z.record(z.string(), z.unknown()).describe('Dados da mudança, no formato descrito nas suas instruções.'),
        },
        run('studio_propose'),
      ),
    );
  }

  return tools.length > 0 ? createSdkMcpServer({ name: 'studio', version: '1.0.0', tools }) : null;
}
