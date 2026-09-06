import { ledgerTaskStateFromLines } from '../lib/task-status-handler';

describe('credit reconciliation ledger parsing', () => {
  const debit = (taskId: string, amount = 12) =>
    JSON.stringify({
      timestamp: '2026-09-02T03:48:27.289Z',
      type: 'debit',
      amount,
      reason: `Task ${taskId} dispatched (credit reservation)`,
      task_id: taskId,
      model: 'z-ai/glm-5.2',
    });

  const refund = (taskId: string, amount = 12) =>
    JSON.stringify({
      timestamp: '2026-09-02T05:37:58.000Z',
      type: 'refund',
      amount,
      reason: `Task ${taskId} failed — reconciled`,
      task_id: taskId,
      model: 'z-ai/glm-5.2',
    });

  it('marks a debited task with no refund as needing a refund', () => {
    const state = ledgerTaskStateFromLines([debit('task_a')]);
    expect(state.debited.has('task_a')).toBe(true);
    expect(state.refunded.has('task_a')).toBe(false);
  });

  it('marks a debited task with a real refund as settled (idempotent)', () => {
    const state = ledgerTaskStateFromLines([debit('task_a'), refund('task_a')]);
    expect(state.debited.has('task_a')).toBe(true);
    expect(state.refunded.has('task_a')).toBe(true);
  });

  it('does not treat a zero-amount refund as a real refund', () => {
    // The historical completion-time refund path recorded amount: 0 no-ops.
    // Those must not mask a missing reservation refund.
    const state = ledgerTaskStateFromLines([
      debit('task_a'),
      refund('task_a', 0),
    ]);
    expect(state.debited.has('task_a')).toBe(true);
    expect(state.refunded.has('task_a')).toBe(false);
  });

  it('skips malformed ledger lines without failing', () => {
    const state = ledgerTaskStateFromLines([
      'not json at all',
      '',
      debit('task_a'),
      '{"type":"debit","amount":12}',
    ]);
    expect(state.debited.has('task_a')).toBe(true);
    expect(state.debited.size).toBe(1);
  });

  it('ignores transactions without a task_id (purchases, transfers)', () => {
    const purchase = JSON.stringify({
      timestamp: '2026-09-01T00:00:00Z',
      type: 'credit',
      amount: 50,
      reason: 'top up',
      task_id: null,
    });
    const state = ledgerTaskStateFromLines([purchase, debit('task_a')]);
    expect(state.debited).toEqual(new Set(['task_a']));
    expect(state.refunded.size).toBe(0);
  });

  it('handles multi-month ledgers by unioning across files', () => {
    const august = ledgerTaskStateFromLines([debit('task_old')]);
    const september = ledgerTaskStateFromLines([
      debit('task_new'),
      refund('task_old'),
    ]);
    expect(august.debited.has('task_old')).toBe(true);
    expect(september.refunded.has('task_old')).toBe(true);
    expect(september.debited.has('task_new')).toBe(true);
  });
});
