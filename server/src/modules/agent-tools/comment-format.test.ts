import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatComment, stepOfTitle } from './comment-format.js';

test('a signed comment carries verdict, agent, step, local time and task over the text', () => {
  const body = formatComment({
    kind: 'reprovado',
    text: '### Relatório de HOM\n- HOM-01: área sempre 0,00 ha',
    author: { agentName: 'hom-screen-ranger', step: 'Testar em HOM', executionId: '01a15e99-85c0-7677-bb91-4d6e6749bb9a' },
    taskRef: 'realtec-vicosa/globalfarm/gf-novo-oficial#37',
    at: new Date('2026-10-21T13:28:00Z'),
  });
  const [who, when] = body.split('\n');
  assert.equal(who, '🔴 **Reprovado** · 🤖 **hom-screen-ranger** · Testar em HOM');
  assert.equal(when, '🕒 21/10/2026 10:28 (Brasília) · gf-novo-oficial#37');
  assert.match(body, /### Relatório de HOM\n- HOM-01/);
  assert.match(body, /<sub>Agents Manager Studio · execução 01a15e99<\/sub>$/);
});

test('the step comes from the execution title', () => {
  assert.equal(stepOfTitle('Revisar: [FUNC-029] API — registro de insumos'), 'Revisar');
  assert.equal(stepOfTitle('Publicar em homologação: [FUNC-030] Bug API'), 'Publicar em homologação');
  assert.equal(stepOfTitle('[FUNC-029] sem etapa'), null);
});
