import { create } from 'zustand';
import { db } from '../services/db';

type PerCapitaMode = 'perSpent' | 'perRemain';

interface BudgetState {
  spent: number;
  remain: number;
  perCapita: number;
  mode: PerCapitaMode;
  refreshBudget: (tripId: string, companionCount: number, totalBudget?: number) => Promise<void>;
  toggleMode: () => void;
}

export const useBudgetStore = create<BudgetState>((set, get) => ({
  spent: 0,
  remain: 0,
  perCapita: 0,
  mode: 'perSpent',

  refreshBudget: async (tripId, companionCount, totalBudget) => {
    const spent = await db.sumExpenses(tripId);
    const budget = totalBudget ?? 0;
    const remain = Math.max(0, budget - spent);
    const { mode } = get();
    const perCapita =
      mode === 'perSpent'
        ? spent / Math.max(1, companionCount)
        : remain / Math.max(1, companionCount);
    set({ spent, remain, perCapita });
  },

  toggleMode: () => {
    const { mode, spent, remain } = get();
    const next: PerCapitaMode = mode === 'perSpent' ? 'perRemain' : 'perSpent';
    set({ mode: next });
  },
}));