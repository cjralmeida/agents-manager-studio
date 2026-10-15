// Studio tools offered to the agent as an in-process MCP server ("studio").
// Each tool forwards to the Studio server, which runs it with the workspace credentials:
// tokens never enter the container.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/**
 * @param {(name: string, args: object) => Promise<{ ok: boolean, data?: unknown, error?: string }>} call
 * @param {string[]} groups enabled groups: "board" (read and write), "board_read", "result", "render" (homologation), "render_read" (homologation URLs and logs), "clickup_read", "studio" (Órbi)
 */
export function createStudioTools(call, groups) {
  const run = (name) => async (args) => {
    const response = await call(name, args);
    if (!response.ok) return { ...asText({ erro: response.error }), isError: true };
    // An image the model looks at (e.g. an agent's art preview for Órbi to judge).
    const image = response.data && response.data.image;
    if (image && typeof image.data === 'string') return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
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
      tool(
        'quality_list',
        'Lista o registro de defeitos recorrentes do workspace: categorias, situação (aberta, transversal, resolvida, nao_defeito), tarefa transversal e ocorrências.',
        {},
        run('quality_list'),
      ),
      tool(
        'quality_log',
        'Registra um DEFEITO que bloqueou uma tarefa (reprovação): o resultado diferiu de uma RN, um CA ou do contrato. Nunca registre erro esperado (o teste contrário recebeu a recusa documentada). Devolve quantas tarefas a categoria já tem e o que fazer a seguir.',
        {
          category: z.string().describe('Categoria curta e estável do defeito (reuse uma de quality_list se for o mesmo), ex.: "corpo nulo dá 500".'),
          task: z.string().describe('A tarefa reprovada, "repo#N".'),
          expected: z.string().describe('O que a regra, o critério ou o contrato mandam.'),
          obtained: z.string().describe('O que aconteceu.'),
        },
        run('quality_log'),
      ),
      tool(
        'quality_update',
        'Muda a situação de uma categoria do registro: "transversal" com a referência da tarefa transversal criada, "resolvida", "nao_defeito" ou "aberta".',
        {
          category: z.string(),
          status: z.enum(['aberta', 'transversal', 'resolvida', 'nao_defeito']).optional(),
          transversalRef: z.string().optional().describe('A tarefa transversal, "repo#N".'),
        },
        run('quality_update'),
      ),
    );
  }

  if (groups.includes('test_env')) {
    tools.push(
      tool(
        'test_env_start',
        'Sobe um AMBIENTE DE TESTE local do projeto (a versão mais nova da branch base, pelo docker/test-env/docker-compose.yml dele), para testar quando a homologação não estiver utilizável. Só sobe quando há memória livre no computador; senão fica na fila. Devolve o id: consulte com test_env_status até ficar "ready" e use as URLs.',
        {
          project: z.string().describe('Nome do projeto no workspace (ex.: globalfarm).'),
          variables: z.record(z.string(), z.string()).optional().describe('Variáveis para a stack, ex.: a URL da API de outro ambiente para o front.'),
        },
        run('test_env_start'),
      ),
      tool(
        'test_env_status',
        'Situação de um ambiente de teste (queued, building, ready, failed, stopped) e as URLs dos serviços; sem id, lista os seus.',
        { id: z.string().optional() },
        run('test_env_status'),
      ),
      tool('test_env_stop', 'Derruba um ambiente de teste (sem id, todos os seus). Chame ao terminar os testes.', { id: z.string().optional() }, run('test_env_stop')),
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
      tool(
        'render_metrics',
        'Memória (MB, com o limite e o pico) e CPU de um serviço de homologação numa janela recente — para medir consumo e estabilidade (ex.: "fica abaixo de 512 MB por 30 min").',
        {
          project: z.string().optional().describe('Nome do projeto (veja render_environments); vazio usa o seu projeto.'),
          minutes: z.number().int().optional().describe('Janela até agora, em minutos (padrão 60, de 5 a 1440).'),
        },
        run('render_metrics'),
      ),
      tool(
        'render_events',
        'Eventos de um serviço de homologação, do mais novo ao mais antigo: deploys, instância que caiu (com o motivo, ex.: falta de memória) e reinícios.',
        {
          project: z.string().optional().describe('Nome do projeto (veja render_environments); vazio usa o seu projeto.'),
          minutes: z.number().int().optional().describe('Só os eventos dos últimos N minutos (vazio: os mais recentes).'),
          limit: z.number().int().optional().describe('Quantidade (padrão 30, até 100).'),
        },
        run('render_events'),
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

  if (groups.includes('projects')) {
    tools.push(
      tool('project_owners', 'Lista onde a conta git do workspace pode criar repositórios (seu usuário e organizações).', {}, run('project_owners')),
      tool(
        'project_create',
        'Cria um projeto novo no workspace com repositório PRIVADO no git (pasta + repositório + primeiro commit). Só depois de o usuário confirmar nome e lugar. Os próximos passos do workflow trabalham nele.',
        {
          name: z.string().describe('Nome do projeto: pasta e repositório (ex.: neon-runner). Letras minúsculas, números e hífen.'),
          description: z.string().optional(),
          owner: z.string().optional().describe('Onde criar (de project_owners): usuário ou organização.'),
        },
        run('project_create'),
      ),
      tool(
        'project_use',
        'Escolhe um projeto que JÁ EXISTE no workspace (ex.: um jogo sendo revisado) para os próximos passos do workflow trabalharem nele, em vez de criar um novo.',
        { name: z.string().describe('Nome do projeto no workspace (ex.: the-golden-mug).') },
        run('project_use'),
      ),
    );
  }

  if (groups.includes('clickup_read')) {
    tools.push(
      tool(
        'clickup_hierarchy',
        'Mostra a estrutura do ClickUp da conta do workspace: workspaces, espaços, pastas e listas (com ids), para achar onde estão as tarefas.',
        {},
        run('clickup_hierarchy'),
      ),
      tool(
        'clickup_list_tasks',
        'Lista as tarefas de uma lista do ClickUp (100 por página, incluindo fechadas e subtarefas): id, nome, status, responsáveis, tags, datas.',
        { listId: z.string(), page: z.number().int().optional().describe('Página, começando em 0.') },
        run('clickup_list_tasks'),
      ),
      tool(
        'clickup_get_task',
        'Lê uma tarefa do ClickUp por inteiro: descrição em Markdown, subtarefas, checklists, campos personalizados e, se pedir, os comentários.',
        { taskId: z.string(), comments: z.boolean().optional() },
        run('clickup_get_task'),
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
        'studio_overview',
        'Visão geral de TODOS os workspaces do usuário: workflows ligados/desligados, pausas do Órbi, execuções rodando, agentes (e se o container está no ar), perguntas esperando, falhas, sugestões de capacidade, memória do computador, ambientes de teste e uso do plano.',
        {},
        run('studio_overview'),
      ),
      tool(
        'studio_focus',
        'Muda o workspace em que esta conversa atua (as ferramentas do quadro, do contexto e das execuções passam a valer nele).',
        { workspace: z.string().describe('Nome ou id do workspace.') },
        run('studio_focus'),
      ),
      tool(
        'studio_pending',
        'O que está esperando alguém no workspace (ou em todos, com all): perguntas de agentes com as opções, execuções que falharam nas últimas 24 h, sugestões do Gestor de Capacidade, tarefas travadas no quadro e avisos deixados para o usuário.',
        { all: z.boolean().optional() },
        run('studio_pending'),
      ),
      tool(
        'studio_agent',
        'Uma execução de agente de qualquer workspace: estado, pergunta pendente, resultado, prévias (media) e o final da linha do tempo.',
        { id: z.string() },
        run('studio_agent'),
      ),
      tool(
        'studio_view_file',
        'Abre uma imagem que um agente mostrou (prévia de arte, captura de tela) para você ver. Aceita a URL /api/agents/<id>/files/<caminho> ou agentId + path. Áudio não dá para ouvir: volta só o tamanho.',
        { url: z.string().optional(), agentId: z.string().optional(), path: z.string().optional() },
        run('studio_view_file'),
      ),
      tool(
        'studio_answer',
        'Responde as perguntas pendentes de um agente em nome do usuário (uma resposta por pergunta, na ordem; use o rótulo da opção escolhida, com um complemento curto se ajudar). Fica registrado na atividade do Órbi.',
        {
          agentId: z.string(),
          answers: z.array(z.string()).describe('Uma resposta por pergunta, na mesma ordem.'),
          reason: z.string().optional().describe('Por que escolheu (vai para o relato).'),
        },
        run('studio_answer'),
      ),
      tool(
        'studio_message',
        'Manda uma mensagem a uma execução de agente (ela volta a trabalhar com a mensagem). Ex.: retomar um agente parado, passar uma regra nova, pedir uma correção.',
        { agentId: z.string(), text: z.string() },
        run('studio_message'),
      ),
      tool(
        'studio_set_workflow',
        'Liga ou desliga um workflow e/ou muda quantas execuções ele roda ao mesmo tempo (1 a 5). Não altera gatilho nem passos (isso é proposta).',
        { workflowId: z.string(), enabled: z.boolean().optional(), maxConcurrentRuns: z.number().int().optional(), reason: z.string().optional() },
        run('studio_set_workflow'),
      ),
      tool(
        'studio_pause',
        'Pausa um workspace: desliga os workflows ligados (guardando quais eram) e, por padrão, para os agentes que estão trabalhando, para retomarem depois de onde pararam. Use stopAgents false para só não pegar tarefas novas e deixar os atuais terminarem.',
        { workspace: z.string(), stopAgents: z.boolean().optional(), reason: z.string().optional() },
        run('studio_pause'),
      ),
      tool(
        'studio_resume',
        'Retoma um workspace pausado pelo Órbi: religa os workflows que a pausa desligou e manda os agentes parados continuarem. Com workflows false, só retoma os agentes (os workflows ficam desligados).',
        { workspace: z.string(), workflows: z.boolean().optional(), reason: z.string().optional() },
        run('studio_resume'),
      ),
      tool(
        'studio_capacity',
        'Aplica ou descarta uma sugestão do Gestor de Capacidade (proposalId de studio_pending).',
        { proposalId: z.string(), decision: z.enum(['apply', 'discard']), reason: z.string().optional() },
        run('studio_capacity'),
      ),
      tool(
        'studio_conflict_back',
        'Devolve um conflito de merge ao agente que fez o trabalho: traz a branch de destino para a cópia dele e pede para resolver; ao terminar, o Studio tenta o merge de novo e a execução do workflow é retomada.',
        { agentId: z.string() },
        run('studio_conflict_back'),
      ),
      tool(
        'studio_flag',
        'Deixa um aviso para o usuário na página do Órbi (algo que precisa dele: mudança grande de escopo, credencial, decisão que você não deve tomar).',
        { summary: z.string(), details: z.string().optional(), link: z.string().optional(), workspace: z.string().optional() },
        run('studio_flag'),
      ),
      tool(
        'studio_resources',
        'Recursos do computador: CPU, memória, discos, limites de lançamento, ambientes de teste no ar e quantos mais cabem.',
        {},
        run('studio_resources'),
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
