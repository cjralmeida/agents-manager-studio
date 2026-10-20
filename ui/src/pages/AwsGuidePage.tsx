import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../components/Button';

/** What the Studio's IAM user may do in the workspace's account (an account only for the workspace, in the Organization). */
const POLICY = `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DeployDoStudio",
      "Effect": "Allow",
      "Action": [
        "ec2:*",
        "ssm:*",
        "ecr:*",
        "logs:*",
        "cloudwatch:GetMetricData",
        "amplify:*",
        "route53:*",
        "acm:DescribeCertificate",
        "acm:ListCertificates"
      ],
      "Resource": "*"
    },
    {
      "Sid": "FuncaoDasInstancias",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:CreateRole",
        "iam:AttachRolePolicy",
        "iam:PutRolePolicy",
        "iam:GetInstanceProfile",
        "iam:CreateInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:PassRole"
      ],
      "Resource": ["arn:aws:iam::*:role/studio-*", "arn:aws:iam::*:instance-profile/studio-*"]
    },
    {
      "Sid": "PapeisDeServicoDaAws",
      "Effect": "Allow",
      "Action": "iam:CreateServiceLinkedRole",
      "Resource": "*"
    }
  ]
}`;

/**
 * The only manual part of deploying on AWS: the workspace's account in the Organization and the Studio's IAM user.
 * From there the Studio creates and sets up the rest (Deploys tab of the workspace).
 */
export function AwsGuidePage() {
  return (
    <article className="max-w-3xl space-y-6 text-sm leading-relaxed">
      <header>
        <Link to="/connectors" className="text-sm text-muted hover:text-white">
          ← Conectores
        </Link>
        <h1 className="mt-3 text-xl font-semibold">Ligar um workspace à AWS</h1>
        <p className="mt-2 text-muted">
          Cada workspace tem uma conta própria da AWS dentro da sua Organization: a fatura consolidada mostra o custo de cada um. Você cria a conta e um usuário IAM
          só para o Studio. A partir daí o Studio faz o resto sozinho: a instância EC2 do backend (Docker, Caddy com HTTPS, IP fixo), o app do Amplify do
          frontend, as imagens no ECR, as variáveis no Parameter Store e o DNS.
        </p>
      </header>

      <Step number={1} title="Criar a conta do workspace (na conta de gerenciamento)">
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            AWS Organizations → <b>Add an AWS account</b> → <b>Create an AWS account</b>.
          </li>
          <li>
            Nome: <code>Studio - &lt;Workspace&gt;</code>. E-mail: um exclusivo (ex.: <code>aws+globalfarm@empresa.com.br</code>).
          </li>
          <li>
            Função IAM: deixe <code>OrganizationAccountAccessRole</code>.
          </li>
          <li>
            Opcional: em Billing → <b>Budgets</b>, um orçamento mensal para a conta com alerta por e-mail.
          </li>
          <li>
            Entre na conta nova: menu da conta → <b>Switch role</b> → número da conta nova, função <code>OrganizationAccountAccessRole</code>. Os passos seguintes
            são feitos nela.
          </li>
        </ol>
      </Step>

      <Step number={2} title="Criar a política do Studio">
        <p>
          IAM → Policies → <b>Create policy</b> → JSON → cole a política abaixo → nome <code>StudioDeploy</code>. Ela vale só dentro da conta do workspace; o
          Studio só cria funções IAM com nome <code>studio-*</code> (a das instâncias).
        </p>
        <CopyBlock text={POLICY} />
        <p className="text-muted">
          Uma conta ligada antes desta versão tem uma política menor: troque o conteúdo dela por este (IAM → Policies → StudioDeploy → Edit) para o Studio poder
          criar instâncias, apps e registros de DNS.
        </p>
      </Step>

      <Step number={3} title="Criar o usuário e a chave">
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            IAM → Users → <b>Create user</b> <code>studio-deploy</code>, sem acesso ao console, com a política <code>StudioDeploy</code>.
          </li>
          <li>
            No usuário → Security credentials → <b>Create access key</b> → "Application running outside AWS". Copie o <b>Access key ID</b> e o{' '}
            <b>Secret access key</b> (o segredo só aparece uma vez).
          </li>
        </ol>
      </Step>

      <Step number={4} title="Cadastrar no Studio">
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            <Link to="/connectors" className="text-accent hover:underline">
              Conectores
            </Link>{' '}
            → <b>Contas da AWS</b> → nome, região (ex.: <code>us-east-1</code>, <code>sa-east-1</code>) e as duas chaves. O Studio confere a chave e mostra o
            número da conta.
          </li>
          <li>
            No workspace → aba <b>Conectores</b> → <b>AWS</b>: escolha a conta.
          </li>
        </ol>
      </Step>

      <Step number={5} title="DNS (para o Studio criar os registros sozinho)">
        <p>
          O Studio cria os registros de DNS quando o domínio do endereço está numa zona do Route 53 da conta do workspace. Se o domínio da empresa fica em outra
          conta, delegue só um subdomínio:
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Na conta do workspace: Route 53 → <b>Create hosted zone</b> → o subdomínio (ex.: <code>v2.empresa.com.br</code>), pública. Anote os 4 servidores de nome
            (registro NS).
          </li>
          <li>
            Na zona do domínio principal (na outra conta): um registro <b>NS</b> com o nome do subdomínio (ex.: <code>v2</code>) e esses 4 servidores, TTL 300.
            Antes, recrie na zona nova os registros que já existiam abaixo do subdomínio e apague-os da zona principal.
          </li>
        </ol>
        <p className="text-muted">
          Sem isso o deploy funciona igual: a aba Deploys mostra os registros para você criar no seu DNS.
        </p>
      </Step>

      <Step number={6} title="Configurar os deploys">
        <p>
          No workspace → aba <b>Deploys</b>, escolha o destino de cada projeto em homologação e em produção:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <b>Backend no EC2</b>: uma instância existente ou uma nova (você escolhe o tipo) e o endereço. O Studio cria a instância, o IP fixo, o registro de DNS,
            instala Docker e Caddy, e a cada deploy gera a imagem pelo Dockerfile do repositório. As variáveis do serviço ficam no Parameter Store.
          </li>
          <li>
            <b>Frontend no Amplify</b>: o Studio cria o app ligado ao repositório com o token git do workspace (no GitLab, o token precisa do papel Maintainer e
            do escopo <code>api</code>, para o Amplify criar a deploy key), com o build automático desligado, e o domínio, se você informar um.
          </li>
        </ul>
      </Step>

      <section>
        <h2 className="font-semibold">Custos de referência (por workspace, por ambiente)</h2>
        <table className="mt-2 text-sm">
          <tbody className="divide-y divide-border">
            {[
              ['EC2 t3.small (t3.medium com banco junto)', 'US$ 15 (US$ 30) / mês'],
              ['Disco 30 GB gp3 + IP fixo', '~US$ 6 / mês'],
              ['ECR, Parameter Store, CloudWatch', '~US$ 1–3 / mês'],
              ['Amplify (build + hospedagem de um front pequeno)', '~US$ 1–5 / mês'],
              ['Route 53 (uma zona)', 'US$ 0,50 / mês'],
            ].map(([item, cost]) => (
              <tr key={item}>
                <td className="py-1 pr-6">{item}</td>
                <td className="py-1 text-muted">{cost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </article>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">
        {number}. {title}
      </h2>
      {children}
    </section>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs">{text}</pre>
      <Button size="sm" className="absolute top-2 right-2" onClick={copy}>
        {copied ? 'Copiado' : 'Copiar'}
      </Button>
    </div>
  );
}
