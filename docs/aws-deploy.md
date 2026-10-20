# Deploy na AWS pelo Studio

Cada workspace ligado à AWS é **uma conta separada dentro do AWS Organizations** da empresa (a fatura consolidada
mostra o custo de cada um). A única parte manual é criar essa conta e o **usuário IAM do Studio**; o passo a passo,
com a política para copiar, está no próprio Studio em **`/guia/aws`** (link na aba Conectores → AWS do workspace).

Depois disso, a aba **Deploys** do workspace diz onde cada projeto é publicado em homologação e em produção: sem
deploy, um serviço do Render, um **EC2** (backend) ou um app do **Amplify** (frontend). Um projeto publica em um lugar
por ambiente: escolher a AWS tira o Render daquele ambiente e vice-versa.

## O que o Studio cria e configura

**Backend no EC2** (instância existente ou nova, do tipo escolhido):
- função e perfil de instância `studio-ec2` (SSM, ECR, CloudWatch, parâmetros `/ams/*`), security group `studio-web`
  (80/443) e Amazon Linux 2023 com tag `studio=true`;
- Elastic IP e registro **A** do endereço, quando o domínio está numa zona do Route 53 da conta (senão a aba mostra o
  registro para criar);
- pelo SSM: Docker, Caddy (HTTPS automático, um arquivo por site em `/etc/caddy/sites/`) e o agente do CloudWatch
  (métrica de memória);
- uma porta por serviço (a partir de 8080): vários backends dividem a mesma instância, cada um no seu endereço;
- a cada deploy: imagem pelo Dockerfile do repositório no commit do merge → ECR `ams-<projeto>-<hom|prod>` → a
  instância troca o container, com o `.env` vindo do Parameter Store `/ams/<serviço>/`, e o Studio espera o health
  check.

**Frontend no Amplify** (app existente ou novo):
- app ligado ao repositório com o token git do workspace (GitHub: token; GitLab: papel Maintainer e escopo `api`,
  para o Amplify criar a deploy key), build automático desligado, regra de rewrite das rotas e build que detecta
  pnpm (9 para lockfile 9), yarn ou npm, publicando a pasta escolhida (padrão `dist`);
- domínio próprio, se informado: os registros de validação e o apontamento (alias para o CloudFront) são criados no
  Route 53 da conta, ou mostrados para criar à mão;
- a cada deploy: um job RELEASE do commit do merge.

A configuração roda em segundo plano, retoma depois de um reinício e pode ser repetida pela aba Deploys (por exemplo
depois de criar os registros de DNS à mão ou de atualizar a política do usuário).
