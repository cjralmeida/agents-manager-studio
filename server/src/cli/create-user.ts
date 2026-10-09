/**
 * Creates a Studio user from the terminal (the first admin, or when the Users screen is not at hand).
 *
 *   docker compose exec server npx tsx src/cli/create-user.ts --email ana@x.com --name "Ana" [--admin] [--adopt] [--password-stdin]
 *
 * Without --password-stdin a random password is generated and printed once. --adopt gives the new user the board
 * settings that were Studio-wide before users existed (the data itself was assigned when the users migration ran).
 */
import { prisma } from '../db.js';
import { generatePassword, hashPassword, passwordProblem } from '../lib/password.js';
import { emailProblem, normalizeEmail } from '../modules/users/rules.js';

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const email = normalizeEmail(option('email') ?? '');
  const name = (option('name') ?? '').trim();
  const problem = emailProblem(email) ?? (name ? null : 'Informe --name.');
  if (problem) throw new Error(problem);

  const fromStdin = flag('password-stdin');
  const password = fromStdin ? await readStdin() : generatePassword();
  const weak = passwordProblem(password);
  if (weak) throw new Error(weak);

  const user = await prisma.user.create({
    data: { email, name, passwordHash: await hashPassword(password), role: flag('admin') ? 'ADMIN' : 'MEMBER' },
  });
  console.log(`Usuário criado: ${user.name} <${user.email}> (${user.role}).`);
  if (!fromStdin) console.log(`Senha (guarde agora, não é exibida de novo): ${password}`);

  if (flag('adopt')) {
    // Board model and GitHub board template were Studio-wide before users existed.
    const moved: string[] = [];
    for (const key of ['boardModel', 'githubBoardTemplateUrl']) {
      const setting = await prisma.studioSetting.findUnique({ where: { key } });
      if (!setting) continue;
      await prisma.userSetting.upsert({
        where: { userId_key: { userId: user.id, key } },
        create: { userId: user.id, key, value: setting.value as object },
        update: { value: setting.value as object },
      });
      await prisma.studioSetting.delete({ where: { key } });
      moved.push(key);
    }
    console.log(moved.length ? `Configurações que agora são dele: ${moved.join(', ')}.` : 'Nenhuma configuração global para adotar.');
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
