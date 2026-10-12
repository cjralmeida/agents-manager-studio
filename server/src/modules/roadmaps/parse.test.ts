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
