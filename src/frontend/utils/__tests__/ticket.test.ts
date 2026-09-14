import { describe, it, expect } from 'vitest';
import { ticketAmount, ticketSummary } from '../ticket';
import type { Expense } from '../../types';

describe('ticketAmount', () => {
  it('成人 + 老人按各自单价合计', () => {
    expect(ticketAmount({ count: 4, unitPrice: 120, seniorCount: 1, seniorPrice: 60 })).toBe(420);
  });
  it('无老人 = 张数×成人单价', () => {
    expect(ticketAmount({ count: 3, unitPrice: 100 })).toBe(300);
  });
  it('老人免费(seniorPrice=0)= 只计成人', () => {
    expect(ticketAmount({ count: 3, unitPrice: 80, seniorCount: 1, seniorPrice: 0 })).toBe(160);
  });
  it('空输入回退 0', () => {
    expect(ticketAmount({})).toBe(0);
    expect(ticketAmount({ count: 0, unitPrice: 100 })).toBe(0);
  });
  it('老人张数超过总人数时截断', () => {
    expect(ticketAmount({ count: 2, unitPrice: 100, seniorCount: 5, seniorPrice: 50 })).toBe(100);
  });
});

describe('ticketSummary', () => {
  const base: Expense = { id: 'e1', tripId: 't1', category: 'ticket', amount: 420, currency: 'CNY', dirty: 0 };

  it('成人+老人展示完整摘要', () => {
    expect(ticketSummary({ ...base, ticketCount: 4, unitPrice: 120, seniorCount: 1, seniorPrice: 60 })).toBe('4 人 · 成人3×120 · 老人1×60');
  });
  it('无老人只显示人数和成人单价', () => {
    expect(ticketSummary({ ...base, ticketCount: 2, unitPrice: 100 })).toBe('2 人 · 成人2×100');
  });
  it('老人免费不显示 ×0', () => {
    expect(ticketSummary({ ...base, ticketCount: 3, unitPrice: 80, seniorCount: 1, seniorPrice: 0 })).toBe('3 人 · 成人2×80 · 老人1');
  });
  it('旧数据(无 ticketCount)返回 null', () => {
    expect(ticketSummary({ ...base, amount: 60 })).toBeNull();
  });
  it('单价为 0 时不显示成人单价', () => {
    expect(ticketSummary({ ...base, ticketCount: 2, unitPrice: 0 })).toBe('2 人');
  });
});
