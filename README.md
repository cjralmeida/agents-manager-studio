# Agents Manager Studio

Gerenciador pessoal de agentes de programação, organizado por workspaces (pastas de `D:\Projetos`).

## Serviços

| URL | Serviço |
|---|---|
| http://studio.localhost | UI (`ui/`, React + Vite) |
| http://studio.localhost/api | Server (`server/`, Fastify + Prisma) |
| http://n8n.localhost | n8n |

Todos passam pelo proxy Caddy (`infra/proxy/Caddyfile`) na porta 80. O Postgres guarda os bancos `studio` e `n8n`.

## Primeira execução

```sh
cp .env.example .env   # preencha os valores
docker compose up -d --build
```

## Desenvolvimento (hot reload)

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Server e UI rodam a partir do código-fonte montado no container; edições no Windows recarregam sozinhas (via polling).

Migrations (com o modo dev rodando):

```sh
docker compose exec server npx prisma migrate dev --name <descricao>
```

## Estrutura

```
infra/      proxy (Caddyfile) e scripts de init do Postgres
server/     backend: src/modules/<modulo>/routes.ts + service.ts, prisma/
ui/         frontend: src/api, src/components, src/pages
```

## Quadro de tarefas

Cada workspace pode vincular um quadro próprio (aba **Quadro**):

- **GitHub:** um GitHub Project (v2). O token fine-grained da conta precisa de *Projects: leitura e escrita* na organização e *Issues: leitura e escrita* nos repositórios.
- **GitLab:** um board de grupo. As colunas são labels `Status: …` e os campos são labels `Campo: valor`. "A fazer" corresponde às issues abertas sem coluna, e "Concluído" às fechadas.

Se o Studio não encontrar um quadro, ele pode criar um no estilo do template (`server/src/modules/boards/template.ts`). No GitHub, ele copia o projeto-modelo definido em Configurações → Git, quando houver.

Ao lançar um agente a partir de um card:

1. a tarefa vai para a coluna de andamento;
2. o PR/MR referencia a issue com `Closes #N`;
3. a tarefa vai para validação.

Os papéis das colunas ficam em Configuração do workspace. Tarefas na coluna "bloqueada" ("Aguardando aprovação") não aceitam agentes.

## Agentes: ambiente, avisos e consumo

- **Imagem do agente** (`agent-runner/`): traz Node.js 24, Python 3 (com pip e venv), git e o Claude Code. Depois de alterá-la, reconstrua com `docker compose --profile tools build agent-runner`.
- **Notificações do navegador:** para ativar, use o botão no rodapé do menu lateral. O aviso chega quando um agente faz uma pergunta, fica pronto para revisão, abre o PR/MR ou falha, desde que o Studio esteja aberto em alguma aba e sem foco. O título da aba mostra quantos agentes aguardam você.
- **Consumo do Studio no Docker:** o Dashboard mostra memória, CPU, containers e disco, considerando só os serviços do Studio e os agentes. Lançar um agente pede confirmação quando a memória ou a CPU passam de `AGENT_LAUNCH_MEMORY_PERCENT` ou `AGENT_LAUNCH_CPU_PERCENT`, que por padrão são 80% e 85%.
- **Consumo do Claude:** o Dashboard mostra, por conta Claude, as janelas do plano: a sessão de 5 horas e a semanal, em %, com o horário em que reiniciam. Essas janelas vêm junto de cada requisição dos agentes, e o botão "Atualizar" faz uma chamada mínima com o Haiku para lê-las.
- **Uso dos agentes:** o Dashboard mostra tokens e custo estimado, que é o preço de API e não é cobrado no plano Max. Há totais de hoje, 7 e 30 dias, um gráfico dos últimos 14 dias e rankings por workspace, por modelo e por agente. O histórico continua depois que o agente é excluído.
- **Dashboard por workspace** (aba Dashboard do workspace): é o mesmo dashboard do geral, mas restrito ao workspace.
  - Mostra os agentes, o consumo do Claude, os containers dos agentes e o disco usado pelas cópias dos projetos e pelas sessões dos agentes.
  - Os serviços do Studio são compartilhados e aparecem só no geral.
  - As janelas do plano são da conta Claude inteira.

## Sentinelas

As sentinelas ficam na aba **Sentinelas** de cada workspace. Elas vigiam o quadro de tarefas e lançam um agente para cada tarefa do tipo delas.

- **O que a sentinela procura:** tarefas da coluna vigiada (por padrão, "A fazer") que batem com os filtros pelos campos do quadro (Tipo, Área, Prioridade, repositório). A opção "só tarefas sem responsável" fica ligada por padrão.
- **Ordem:** a tarefa de maior prioridade primeiro e, entre iguais, a mais antiga. Uma tarefa que já teve agente não é pega de novo.
- **O que vai para o agente:** a tarefa e as instruções extras da sentinela. O agente segue o fluxo normal: o card vai para andamento e, no fim, você revisa e conclui.
- **Quando ela para:** respeita o limite de agentes simultâneos e pausa quando a janela de 5 horas do Claude passa de `SENTINEL_PLAN_LIMIT_PERCENT` (padrão 80%) ou quando o Docker está no limite.
- **Atualização dos quadros:** o server lê cada quadro a cada 2 minutos (configurável de 1 a 15 minutos na Configuração do workspace) e roda as sentinelas logo depois. Tudo fica no banco, então volta a funcionar sozinho quando o Studio reinicia.
