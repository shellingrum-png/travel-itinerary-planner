/**
 * V6.0 创建向导状态(zustand)
 * 三步:① 城市/天数 → ② 城际晚数 → ③ 模板匹配
 */
import { create } from 'zustand';
import { db } from '../services/db';
import { matchTemplates, applyTemplate, qingganTemplate } from '../services/templates';
import type { TripTemplate, CityNode, Trip } from '../types';

interface WizardState {
  step: 1 | 2 | 3;
  cities: string[];           // 城市名列表
  startDate: string;
  endDate: string;
  nights: Record<string, number>; // city -> 晚数
  matchedTemplates: TripTemplate[];
  selectedTemplateId: string | null;
  creating: boolean;
  error: string | null;

  // actions
  setCities: (cities: string[]) => void;
  removeCity: (city: string) => void;
  setDates: (start: string, end: string) => void;
  setNights: (city: string, nights: number) => void;
  next: () => void;
  back: () => void;
  reset: () => void;
  match: () => Promise<void>;
  selectTemplate: (id: string) => void;
  create: (input: { title: string; companionCount: number; currency: string }) => Promise<Trip | null>;
}

export const useWizardStore = create<WizardState>((set, get) => ({
  step: 1,
  cities: [],
  startDate: '',
  endDate: '',
  nights: {},
  matchedTemplates: [],
  selectedTemplateId: null,
  creating: false,
  error: null,

  setCities: (cities) => set({ cities: cities.filter(Boolean) }),
  removeCity: (city) => {
    const nights = { ...get().nights };
    delete nights[city];
    set({ cities: get().cities.filter((c) => c !== city), nights });
  },
  setDates: (start, end) => set({ startDate: start, endDate: end }),
  setNights: (city, nights) => set({ nights: { ...get().nights, [city]: nights } }),

  next: () => {
    const { step, cities, startDate, endDate, nights } = get();
    if (step === 1) {
      if (cities.length === 0 || !startDate || !endDate) {
        set({ error: '请先填写城市和日期' });
        return;
      }
      if (endDate < startDate) { set({ error: '结束日期不能早于开始日期' }); return; }
      set({ step: 2, error: null });
      return;
    }
    if (step === 2) {
      const totalDays = getTotalDays(startDate, endDate);
      const totalNights = Object.values(nights).reduce((s, n) => s + (n || 0), 0);
      if (totalNights !== totalDays - 1) {
        set({ error: `总晚数必须等于 ${totalDays - 1}（当前 ${totalNights}），请调整` });
        return;
      }
      set({ step: 3, error: null });
      get().match();
    }
  },

  back: () => set({ step: Math.max(1, get().step - 1) as 1 | 2 | 3 }),

  reset: () => set({
    step: 1, cities: [], startDate: '', endDate: '',
    nights: {}, matchedTemplates: [], selectedTemplateId: null,
    creating: false, error: null,
  }),

  match: async () => {
    const { cities } = get();
    if (cities.length === 0) return;
    // 确保内置模板存在
    const all = await db.listTemplates();
    if (all.length === 0) {
      await db.upsertTemplate(qingganTemplate());
    }
    const templates = await db.listTemplates();
    const matched = matchTemplates(templates, cities);
    set({ matchedTemplates: matched, selectedTemplateId: matched[0]?.id ?? null });
  },

  selectTemplate: (id) => set({ selectedTemplateId: id }),

  create: async (input) => {
    const { cities, startDate, endDate, nights, selectedTemplateId, creating } = get();
    if (creating) return null;
    const tpl = get().matchedTemplates.find((t) => t.id === selectedTemplateId) ?? null;

    set({ creating: true, error: null });
    try {
      const cityNodes: CityNode[] = cities.map((city) => ({ city, nights: nights[city] ?? 1 }));

      // 方案甲:套用模板
      if (tpl) {
        const trip = await applyTemplate(tpl, {
          title: input.title || tpl.title,
          startDate, endDate,
          companionCount: input.companionCount,
          currency: input.currency,
          cityNodes,
        });
        return trip;
      }

      // 方案乙:空白行程(仅骨架)
      const trip = await db.createTrip({
        title: input.title,
        destination: cities.join(','),
        startDate, endDate,
        companionCount: input.companionCount,
        currency: input.currency,
        cityNodes,
      });
      return trip;
    } catch (e: any) {
      set({ error: e.message || '创建失败' });
      return null;
    } finally {
      set({ creating: false });
    }
  },
}));

function getTotalDays(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
}