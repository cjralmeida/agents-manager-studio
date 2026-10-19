import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dueByInterval, dueDailyTime, routineMessage } from './routine-schedule.js';

/** A moment given in São Paulo time (UTC−3). */
const sp = (iso: string) => new Date(`${iso}-03:00`);

describe('dueDailyTime', () => {
  const created = sp('2026-10-01T00:00:00');

  it('is due once the time passed and the routine did not run since', () => {
    assert.equal(dueDailyTime(['08:00'], sp('2026-10-18T08:00:00'), created, sp('2026-10-19T08:01:00')), '08:00');
  });

  it('is not due before the time, nor again after running', () => {
    assert.equal(dueDailyTime(['08:00'], sp('2026-10-18T08:00:00'), created, sp('2026-10-19T07:59:00')), null);
    assert.equal(dueDailyTime(['08:00'], sp('2026-10-19T08:01:00'), created, sp('2026-10-19T09:00:00')), null);
  });

  it('skips a time missed by hours (the computer was off)', () => {
    assert.equal(dueDailyTime(['08:00'], sp('2026-10-18T08:00:00'), created, sp('2026-10-19T12:00:00')), null);
  });

  it('does not run a time that passed before the routine was created', () => {
    assert.equal(dueDailyTime(['08:00'], null, sp('2026-10-19T08:30:00'), sp('2026-10-19T08:31:00')), null);
  });

  it('picks the latest due time of the day', () => {
    assert.equal(dueDailyTime(['08:00', '13:00'], sp('2026-10-19T08:00:30'), created, sp('2026-10-19T13:05:00')), '13:00');
  });

  it('uses São Paulo time near midnight UTC', () => {
    // 22:30 in São Paulo is 01:30 UTC of the next day.
    assert.equal(dueDailyTime(['22:30'], sp('2026-10-18T22:30:00'), created, sp('2026-10-19T22:31:00')), '22:30');
  });
});

describe('dueByInterval', () => {
  it('runs the first time and then every N minutes', () => {
    const now = sp('2026-10-19T10:00:00');
    assert.equal(dueByInterval(15, null, now), true);
    assert.equal(dueByInterval(15, sp('2026-10-19T09:50:00'), now), false);
    assert.equal(dueByInterval(15, sp('2026-10-19T09:45:00'), now), true);
    assert.equal(dueByInterval(null, null, now), false);
  });
});

describe('routineMessage', () => {
  const routine = { name: 'Fila da GF', mode: 'assistant', instructions: 'Conflito de front vai para o ebur.', workspaceIds: ['ws'] };

  it('says the routine, its mode, why it runs, what happened and the rules of the mode', () => {
    const message = routineMessage(routine, [{ name: 'GlobalFarm' }], ['horário agendado 08:00'], ['- Execução falhou']);
    assert.match(message, /^\[Rotina "Fila da GF" · Assistente\] Workspaces: GlobalFarm\./);
    assert.match(message, /Por que agora: horário agendado 08:00\./);
    assert.match(message, /O que aconteceu:\n- Execução falhou/);
    assert.match(message, /Instruções da rotina:\nConflito de front vai para o ebur\./);
    assert.match(message, /Modo ASSISTENTE/);
  });

  it('acts by itself in auto mode and watches every workspace when none is chosen', () => {
    const message = routineMessage({ ...routine, mode: 'auto', instructions: '', workspaceIds: [] }, [{ name: 'A' }, { name: 'B' }], [], []);
    assert.match(message, /· Automático\] Workspaces: todos\./);
    assert.match(message, /Modo AUTOMÁTICO/);
    assert.match(message, /Instruções da rotina: nenhuma/);
  });
});
