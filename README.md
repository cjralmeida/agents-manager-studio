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

## Conectores

As ferramentas que o Studio e os agentes usam ficam em **Conectores** (menu lateral): **Claude**, **GitHub**, **GitLab** e **Render**.

- **Página Conectores:** onde você conecta as contas. No card do GitHub também fica o projeto-modelo de quadro.
- **Aba Conectores de cada workspace:** onde você escolhe quais contas os agentes daquele workspace usam, vincula o quadro de tarefas e configura o Render (a chave e os serviços são por workspace).
- **Aba Configuração do workspace:** só o que é do próprio workspace: skills, comportamento do quadro (intervalo e papéis das colunas) e copiar a configuração para outros workspaces.

## Workspaces

Cada pasta da **pasta central** (`PROJECTS_HOST_DIR` no `.env`) é um workspace.

- **Criar um workspace:** use **Novo workspace** na página Workspaces. O Studio cria a pasta e a registra. Depois coloque ou clone os projetos dentro dela e clique em "Reler diretório".
- **Clonar um repositório:** use **Clonar repositório** na aba Projetos do workspace.
  - Escolha o repositório na lista das contas git do workspace (no GitLab, a busca é pelo nome do projeto) ou cole a URL, https ou ssh.
  - Os privados usam o token da conta apenas durante o clone; o `origin` fica com a URL sem credenciais.
  - O clone roda em segundo plano, e o projeto aparece sozinho quando termina.
- **Permissões:** o Studio só escreve na pasta central, porque ela é montada com escrita no server, e não no disco inteiro.
- **Trocar a pasta central:** mude `PROJECTS_HOST_DIR` no `.env`, rode `docker compose up -d` e releia o diretório. **Configurações → Geral** mostra a pasta atual.

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

## Agentes do workspace

Os agentes fixos ficam na aba **Agentes** do workspace. Cada um tem:

- um papel com instruções, que vão para o prompt de sistema;
- um modelo;
- os projetos em que trabalha. Sem projeto, ele trabalha sem repositório;
- o tipo de entrega: código (commit + PR/MR) ou resultado;
- acesso opcional ao quadro de tarefas;
- a opção de concluir sozinho.

Pelo quadro, os agentes usam ferramentas do Studio via MCP: `board_list_tasks`, `board_get_task`, `board_create_task`, `board_update_task` e `report_result`. Quem executa essas ferramentas é o server, então os tokens nunca entram nos containers.

## Workflows

Os workflows ficam na aba **Workflows** do workspace. Um workflow tem um **gatilho** e uma sequência de **passos**, e cada passo recebe o resultado do anterior.

- **Gatilhos:**
  - uma mensagem sua, como uma conversa no Studio;
  - uma tarefa que aparece no quadro e bate com os filtros (coluna, campos, repositório, sem responsável).
- **Passos:**
  - **Agente**, com estas opções:
    - "para cada tarefa criada pelo passo anterior": uma linha por tarefa, por padrão uma de cada vez;
    - "continuar do trabalho do passo anterior": começa da cópia e da branch do agente anterior;
    - "se falhar, devolver para o passo X", até N tentativas.
  - **Deploy (Render):** faz o merge do PR/MR e publica o serviço do projeto, por padrão em homologação.
- **Autonomia:** tudo segue sozinho. As perguntas dos agentes continuam esperando a sua resposta.
- **Pausas:** os workflows pausam quando a janela de 5 horas do Claude passa de `WORKFLOW_PLAN_LIMIT_PERCENT` (padrão 80%) ou quando o Docker está no limite.
- **Atualização dos quadros:** o server lê os quadros a cada 2 minutos. Isso é configurável de 1 a 15 minutos.
- **Retomada:** tudo fica no banco, então os workflows continuam de onde pararam quando o Studio reinicia.
- **Base das cópias:** as cópias novas partem da versão mais recente da branch base no remoto, para que cada tarefa enxergue o que as anteriores já publicaram.

## Órbi (assistente)

O **Órbi** é o assistente do Studio. Ele abre pelo botão no canto inferior direito, em qualquer tela, e sabe em que workspace e página você está.

- **O que ele faz:** monta agentes e workflows a partir de uma descrição, explica falhas de execuções e responde sobre consumo.
- **Leitura:** é livre.
- **Mudanças:** toda mudança vira uma **proposta** num cartão com **Aplicar** e **Descartar**. Os tipos de proposta são: criar, alterar ou excluir agentes e workflows; iniciar workflows; cancelar execuções; e criar tarefas. O Studio valida a proposta com as mesmas regras dos formulários, antes de mostrá-la e de novo ao aplicar.
- **Limites:** ele não vê tokens nem mexe em contas.
- **Como funciona por dentro:** é uma conversa no mesmo runner dos agentes, com ferramentas próprias (`studio_*`). As instruções dele estão em `server/src/modules/assistant/guide.ts`. As conversas ficam por workspace e não aparecem entre as execuções.

## Deploy (Render)

O deploy é configurado em **Conectores do workspace → Render**:

1. Conecte com a chave de API do Render. Ela fica criptografada e nunca vai para os agentes.
2. Escolha o serviço de **homologação** e, se houver, o de **produção** de cada projeto.

Um deploy faz o merge do PR/MR do agente, quando houver um, e dispara o serviço de homologação. Um monitor acompanha o deploy até ficar no ar ou falhar, mesmo depois de um reinício. O Dashboard do workspace mostra os últimos deploys. `RENDER_API_URL` existe só para testes.
