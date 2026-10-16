# Deploy na AWS pelo Studio — configuração por workspace

Cada workspace do Studio ligado à AWS é **uma conta separada dentro do AWS Organizations** da empresa. Assim a fatura
consolidada já mostra o custo de cada workspace (Billing → Bills, por conta), sem precisar de tags.

Dentro da conta do workspace ficam: o **EC2** de homologação do backend (Docker), os repositórios do **ECR**, as
variáveis no **Parameter Store**, os logs no **CloudWatch** e o app do **Amplify** do frontend. O Studio usa um
**usuário IAM só de deploy**, com permissão mínima — nunca a conta raiz nem a conta de gerenciamento.

Troque `<REGIAO>` pela região (ex.: `sa-east-1`) e `<CONTA>` pelo número da conta do workspace (12 dígitos).

---

## 1. Conta do workspace no Organizations (na conta de gerenciamento)

1. AWS Organizations → **Add an AWS account** → **Create an AWS account**.
   - Nome: `Studio - <Workspace>` (ex.: `Studio - GlobalFarm`).
   - E-mail: um e-mail exclusivo (ex.: `aws+globalfarm@empresa.com.br`).
   - Função IAM: deixe `OrganizationAccountAccessRole` (dá acesso de administrador à conta nova a partir da conta de
     gerenciamento, para você fazer os passos abaixo).
2. (Opcional) Coloque a conta numa OU "Studio" e, em Billing → **Budgets**, crie um orçamento mensal para ela com
   alerta por e-mail (ex.: US$ 40).
3. Entre na conta nova: no console, menu da conta → **Switch role** → conta `<CONTA>`, função
   `OrganizationAccountAccessRole`. Todos os passos seguintes são feitos **dentro da conta do workspace**.

## 2. Usuário IAM de deploy do Studio

1. IAM → Policies → **Create policy** → JSON → cole a política abaixo → nome `StudioDeploy`.
2. IAM → Users → **Create user** `studio-deploy` (sem acesso ao console) → anexe a política `StudioDeploy`.
3. No usuário → Security credentials → **Create access key** → "Application running outside AWS" → copie o
   **Access key ID** e o **Secret access key** (o segredo só aparece uma vez).
4. No Studio: **Conectores → AWS → Adicionar conta** (nome, região, as duas chaves). O Studio confere a chave e
   mostra o número da conta. Depois, no workspace → aba **Conectores → AWS**, escolha essa conta.

Política `StudioDeploy` (troque `<REGIAO>` e `<CONTA>`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InstanciasEComandos",
      "Effect": "Allow",
      "Action": ["ssm:DescribeInstanceInformation", "ssm:GetCommandInvocation", "ssm:ListCommandInvocations"],
      "Resource": "*"
    },
    {
      "Sid": "RodarScriptNasInstanciasDoStudio",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ec2:<REGIAO>:<CONTA>:instance/*",
      "Condition": { "StringEquals": { "ssm:resourceTag/studio": "true" } }
    },
    {
      "Sid": "DocumentoDoScript",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ssm:<REGIAO>::document/AWS-RunShellScript"
    },
    {
      "Sid": "VariaveisDosServicos",
      "Effect": "Allow",
      "Action": ["ssm:GetParametersByPath", "ssm:PutParameter"],
      "Resource": "arn:aws:ssm:<REGIAO>:<CONTA>:parameter/ams/*"
    },
    {
      "Sid": "LoginNoRegistro",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "ImagensDoStudio",
      "Effect": "Allow",
      "Action": [
        "ecr:DescribeRepositories",
        "ecr:CreateRepository",
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": "arn:aws:ecr:<REGIAO>:<CONTA>:repository/ams-*"
    },
    {
      "Sid": "LogsEMetricas",
      "Effect": "Allow",
      "Action": ["logs:FilterLogEvents", "cloudwatch:GetMetricData"],
      "Resource": "*"
    },
    {
      "Sid": "FrontNoAmplify",
      "Effect": "Allow",
      "Action": ["amplify:ListApps", "amplify:GetApp", "amplify:GetBranch", "amplify:UpdateBranch", "amplify:StartJob", "amplify:GetJob", "amplify:ListJobs"],
      "Resource": "arn:aws:amplify:<REGIAO>:<CONTA>:apps/*"
    }
  ]
}
```

O `ssm:SendCommand` só funciona em instâncias com a tag **`studio=true`** (passo 3): o usuário do Studio não consegue
rodar comandos em nenhuma outra máquina da conta.

## 3. EC2 do backend (homologação)

### 3.1 Função da instância

IAM → Roles → **Create role** → AWS service → EC2 → anexe:
- `AmazonSSMManagedInstanceCore` (o Studio fala com a máquina pelo SSM, sem SSH);
- `AmazonEC2ContainerRegistryReadOnly` (baixar a imagem);
- `CloudWatchAgentServerPolicy` (logs do container e métrica de memória).

E uma política em linha `StudioParametros` (o `.env` do container vem do Parameter Store):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ssm:GetParametersByPath", "Resource": "arn:aws:ssm:<REGIAO>:<CONTA>:parameter/ams/*" },
    { "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "*", "Condition": { "StringEquals": { "kms:ViaService": "ssm.<REGIAO>.amazonaws.com" } } },
    { "Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "arn:aws:logs:<REGIAO>:<CONTA>:log-group:/ams/*" }
  ]
}
```

Nome: `studio-ec2`.

### 3.2 Instância

EC2 → **Launch instance**:
- Nome `studio-hom-api`; **tag `studio` = `true`** (obrigatória).
- Imagem **Amazon Linux 2023** (x86_64); tipo **t3.small** (2 vCPU, 2 GB — o mínimo para o Java não ficar sem
  memória como nos 512 MB do Render).
- Disco 20 GB gp3. Sem par de chaves (o acesso é pelo SSM / Session Manager).
- Security group: entrada **80** e **443** de qualquer lugar (Caddy); nada mais. Saída liberada.
- Advanced → **IAM instance profile**: `studio-ec2`.
- Advanced → **User data**: cole o script abaixo (troque o domínio e a porta do app).
- Depois de criar: EC2 → Elastic IPs → **Allocate** e associe à instância; no DNS, aponte o domínio da API de HOM
  (ex.: `api-hom.globalfarm.com.br`) para esse IP.

```bash
#!/bin/bash
set -e
dnf install -y docker
systemctl enable --now docker
# Caddy: HTTPS automático (Let's Encrypt) para o domínio, encaminhando para o container.
dnf install -y 'dnf-command(copr)' && dnf copr enable -y @caddy/caddy && dnf install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
api-hom.globalfarm.com.br {
  reverse_proxy 127.0.0.1:8080
}
EOF
systemctl enable --now caddy
# Métrica de memória para o Studio (mem_used_percent).
dnf install -y amazon-cloudwatch-agent
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'EOF'
{ "metrics": { "append_dimensions": { "InstanceId": "${aws:InstanceId}" }, "metrics_collected": { "mem": { "measurement": ["mem_used_percent"] } } } }
EOF
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
```

Em alguns minutos a instância aparece em Systems Manager → **Fleet Manager** como *Online*: é ela que o Studio lista.

### 3.3 Banco de HOM

Decida antes de mudar (ainda em aberto):
- **Container no próprio EC2** (mais barato): um `postgres:17` com volume, rodando na mesma máquina — nesse caso use
  **t3.medium** (4 GB) para caber API + banco.
- **RDS** `db.t4g.micro` (~US$ 12/mês), na mesma VPC, acessível só pelo security group da instância.

A URL do banco e os demais segredos entram como variáveis do serviço (passo 5): o publicador do Studio cria pelo
`render_set_env_vars`, ou você cadastra em Systems Manager → Parameter Store, em `/ams/<serviço>/<NOME>` (SecureString).

## 4. Amplify do frontend

1. Amplify → **Create new app** → GitLab → autorize e escolha o repositório do front (ex.: `gf-novo-oficial`), branch
   `main`.
2. Build: o Amplify detecta Vite (`npm ci`, `npm run build`, saída `dist`). Ajuste se o projeto for diferente.
3. **Desligue o build automático** da branch (Branch settings → *Disable auto build*): quem publica é o workflow do
   Studio, depois do merge — com ele ligado, cada merge faria dois builds.
4. Variáveis da branch: a URL da API (ex.: `VITE_API_URL=https://api-hom.globalfarm.com.br/rest`).
5. (Opcional) Domínio próprio em *Hosting → Custom domains*.

## 5. Ligar os projetos no Studio

Workspace → aba **Conectores → AWS**:
- Backend (ex.: `globalfarm`), Homologação → **Usar AWS** → *Backend no EC2*: a instância, a URL pública
  (`https://api-hom...`), a porta do container (a do Caddy, ex.: `8080`), o health check (`/health`), a branch
  (`refactor/api`).
- Frontend (ex.: `gf-novo-oficial`), Homologação → **Usar AWS** → *Frontend no Amplify*: o app, a branch (`main`).

A partir daí, o passo "Publicar em homologação" dos workflows publica na AWS: o Studio gera a imagem pelo
**Dockerfile** do repositório, envia ao ECR (`ams-<projeto>-hom`), a instância troca o container com as variáveis do
Parameter Store e o Studio espera o health check responder. "Voltar para o Render" desfaz a escolha.

## Custos de referência (por workspace, homologação)

| Recurso | Aproximado |
|---|---|
| EC2 t3.small (ou t3.medium com o banco junto) | US$ 15 (US$ 30) / mês |
| Disco 20 GB gp3 + Elastic IP | ~US$ 5 / mês |
| ECR, Parameter Store, CloudWatch (pouco volume) | ~US$ 1–3 / mês |
| Amplify (build + hospedagem de um front pequeno) | ~US$ 1–5 / mês |
| RDS db.t4g.micro (se não for container) | ~US$ 12–15 / mês |
