import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUSINESS_HOURS } from './calendar.js';
import { type ProjectMetrics, bulkClosed, combineMetrics } from './metrics.js';

const metrics = (name: string, overrides: Partial<ProjectMetrics>): ProjectMetrics => ({
  projectId: name,
  projectName: name,
  window: { from: '2026-10-01T10:00:00.000Z', to: '2026-10-21T10:00:00.000Z' },
  calendar: { timeZone: 'America/Sao_Paulo', ...BUSINESS_HOURS },
  hoursPerWorkingDay: 10,
  productiveHours: 100,
  pauses: { auto: [], manual: [], pausedHours: 20 },
  tasksDone: 0,
  bulkClosed: 0,
  tasksPerDay: null,
  costPerTask: null,
  agentHoursPerTask: null,
  totalCost: 0,
  byArea: [],
  daily: [],
  error: null,
  ...overrides,
});

describe('system metrics', () => {
  it('adds the paces of projects worked side by side and averages the cost by tasks finished', () => {
    const api = metrics('globalfarm', {
      tasksDone: 30,
      tasksPerDay: 3,
      costPerTask: 4,
      agentHoursPerTask: 2,
      totalCost: 120,
      byArea: [{ area: 'Backend', tasks: 30, costPerTask: 4, agentHoursPerTask: 2 }],
      daily: [{ day: '2026-10-20', done: 2, cost: 8 }],
    });
    const front = metrics('gf-novo-oficial', {
      tasksDone: 10,
      tasksPerDay: 1,
      costPerTask: 1,
      agentHoursPerTask: 0.5,
      totalCost: 10,
      byArea: [{ area: 'Frontend', tasks: 10, costPerTask: 1, agentHoursPerTask: 0.5 }],
      daily: [
        { day: '2026-10-20', done: 1, cost: 1 },
        { day: '2026-10-21', done: 1, cost: 0 },
      ],
      error: 'GitLab respondeu 500',
    });
    const system = combineMetrics('Plataforma web', [api, front])!;
    assert.equal(system.projectName, 'Plataforma web');
    assert.equal(system.tasksDone, 40);
    assert.equal(system.tasksPerDay, 4);
    assert.equal(system.costPerTask, 3.25);
    assert.equal(system.agentHoursPerTask, 1.63);
    assert.equal(system.totalCost, 130);
    assert.deepEqual(system.byArea.map((area) => area.area), ['Backend', 'Frontend']);
    assert.deepEqual(system.daily, [
      { day: '2026-10-20', done: 3, cost: 9 },
      { day: '2026-10-21', done: 1, cost: 0 },
    ]);
    assert.equal(system.error, 'gf-novo-oficial: GitLab respondeu 500');
  });

  it('keeps a single project as it is and has nothing without projects', () => {
    const only = metrics('the-golden-mug', { tasksDone: 5, tasksPerDay: 2 });
    assert.equal(combineMetrics('The Golden Mug', [only]), only);
    assert.equal(combineMetrics('Vazio', []), null);
  });
});

describe('bulk closes', () => {
  const at = (minute: number) => Date.parse('2026-10-09T18:00:00Z') + minute * 60_000;
  const task = (number: number, minute: number) => ({ ref: `group/globalfarm#${number}`, title: `#${number}`, closedAt: at(minute) });

  it('leaves out a run of ten or more closings nobody worked on', () => {
    const cleanup = Array.from({ length: 12 }, (_, index) => task(index + 1, index));
    const worked = [task(50, 120), task(51, 121), task(52, 122)];
    assert.deepEqual([...bulkClosed([...worked, ...cleanup], new Map([['globalfarm#50', {}]]))].sort(), cleanup.map((entry) => entry.ref).sort());
  });

  it('keeps a run in which some task had an agent, and short runs', () => {
    const run = Array.from({ length: 12 }, (_, index) => task(index + 1, index));
    assert.equal(bulkClosed(run, new Map([['globalfarm#3', {}]])).size, 0);
    assert.equal(bulkClosed(run.slice(0, 9), new Map()).size, 0);
  });
});
