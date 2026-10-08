/** Render deploy statuses that end a deploy; anything else is still in progress. */
const FAILED = ['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled'];
/** "deactivated" means a newer deploy replaced this one after it went live. */
const SUCCEEDED = ['live', 'deactivated'];
/** Studio-side statuses before or instead of a Render deploy. */
const STUDIO_FAILED = ['error'];

export function isFinished(status: string) {
  return FAILED.includes(status) || SUCCEEDED.includes(status) || STUDIO_FAILED.includes(status);
}

export function isSuccess(status: string) {
  return SUCCEEDED.includes(status);
}

const LABELS: Record<string, string> = {
  merging: 'Fazendo merge do PR/MR',
  starting: 'Iniciando',
  created: 'Na fila',
  queued: 'Na fila',
  build_in_progress: 'Compilando',
  update_in_progress: 'Publicando',
  pre_deploy_in_progress: 'Pré-deploy',
  live: 'No ar',
  deactivated: 'Substituído',
  build_failed: 'Falha no build',
  update_failed: 'Falha ao publicar',
  pre_deploy_failed: 'Falha no pré-deploy',
  canceled: 'Cancelado',
  error: 'Erro',
};

export function statusLabel(status: string) {
  return LABELS[status] ?? status;
}

/** PR/MR number from its url (GitHub /pull/12, GitLab /-/merge_requests/12). */
export function pullRequestNumber(url: string) {
  const match = /\/(?:pull|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? Number(match[1]) : null;
}
