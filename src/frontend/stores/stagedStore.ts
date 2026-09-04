import { create } from 'zustand';

export interface StagedPoi {
  id: string;
  name: string;
  address: string;
  lng: number;
  lat: number;
  type: string;
}

interface StagedState {
  staged: StagedPoi[];
  addToStaged: (poi: StagedPoi) => void;
  removeFromStaged: (id: string) => void;
  clearStaged: () => void;
}

export const useStagedStore = create<StagedState>((set, get) => ({
  staged: [],
  addToStaged: (poi) => {
    const { staged } = get();
    if (staged.find((s) => s.id === poi.id)) return;
    set({ staged: [...staged, poi] });
  },
  removeFromStaged: (id) => {
    set({ staged: get().staged.filter((s) => s.id !== id) });
  },
  clearStaged: () => set({ staged: [] }),
}));