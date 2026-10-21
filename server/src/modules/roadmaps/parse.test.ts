import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deliveryOfTask, isPlanningTask, parseRoadmap } from './parse.js';

describe('parseRoadmap', () => {
  it('reads each delivery with its fields, in order', () => {
    const roadmap = parseRoadmap(
      [
        '# Roadmap',
        '',
        '## Entrega 2 — Taberna',
        '**Objetivo:** escolher o herói na taberna.',
        '',
        '## Entrega 1 — Núcleo',
        '**Objetivo:** uma partida completa com o Paladino.',
        '**Escopo:** M-01 a M-08;',
        '- 1 bioma procedural',
        '**Fora do escopo:** linhagem.',
        '**Critérios de pronto:** CA-01, CA-02',
        '',
        '# Histórico',
        'nada aqui',
      ].join('\n'),
    );
    assert.deepEqual(
      roadmap.map((delivery) => [delivery.number, delivery.name]),
      [
        [1, 'Núcleo'],
        [2, 'Taberna'],
      ],
    );
    assert.equal(roadmap[0]!.objective, 'uma partida completa com o Paladino.');
    assert.equal(roadmap[0]!.scope, 'M-01 a M-08;\n- 1 bioma procedural');
    assert.equal(roadmap[0]!.outOfScope, 'linhagem.');
    assert.equal(roadmap[0]!.doneCriteria, 'CA-01, CA-02');
    assert.equal(roadmap[1]!.notes, '');
  });

  it('accepts other dash styles and headings without a name', () => {
    const roadmap = parseRoadmap('## Entrega 3: Chefes\n## Entrega 4\n**Objetivo:** final');
    assert.deepEqual(
      roadmap.map((delivery) => [delivery.number, delivery.name, delivery.objective]),
      [
        [3, 'Chefes', ''],
        [4, '', 'final'],
      ],
    );
  });

  it('reads the plan: dates, estimated tasks and the goal of each day with its tasks', () => {
    const [delivery] = parseRoadmap(
      [
        '## Entrega 1 — Compras',
        '**Início:** 22/10',
        '**Prazo:** 2026-10-28',
        '**Tarefas previstas:** 12 tarefas',
        '**Dias:**',
        '- 2026-10-22 — Compras no ar: globalfarm#101, gf-novo-oficial#27',
        '',
        '- **23/10** (sex): tela de Vendas (#40)',
        'Observação depois dos dias.',
      ].join('\n'),
      2026,
    );
    assert.equal(delivery!.start, '2026-10-22');
    assert.equal(delivery!.deadline, '2026-10-28');
    assert.equal(delivery!.estimatedTasks, 12);
    assert.deepEqual(delivery!.days, [
      { date: '2026-10-22', goal: 'Compras no ar: globalfarm#101, gf-novo-oficial#27', refs: ['globalfarm#101', 'gf-novo-oficial#27'] },
      { date: '2026-10-23', goal: 'tela de Vendas (#40)', refs: ['#40'] },
    ]);
    assert.equal(delivery!.notes, 'Observação depois dos dias.');
  });
});

describe('deliveryOfTask', () => {
  it('finds the "Entrega: N" line in a task body', () => {
    assert.equal(deliveryOfTask('## Objetivo\nfazer\n\nDepende de: #2\nEntrega: 3'), 3);
    assert.equal(deliveryOfTask('**Entrega:** 2'), 2);
    assert.equal(deliveryOfTask('- Entrega 1'), 1);
    assert.equal(deliveryOfTask('Nada de entrega aqui'), null);
  });

  it('tells planning milestones apart', () => {
    assert.equal(isPlanningTask('[The Golden Mug] Planejar a Entrega 2 — Taberna'), true);
    assert.equal(isPlanningTask('[The Golden Mug] Paladino: golpes'), false);
  });
});
