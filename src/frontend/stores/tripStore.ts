import { create } from 'zustand';
import { db } from '../services/db';
import type { Trip } from '../types';

interface TripState {
  trips: Trip[];
  activeTripId: string | null;
  online: boolean;
  loadTrips: () => Promise<void>;
  openTrip: (id: string) => void;
  closeTrip: () => void;
  setOnline: (on: boolean) => void;
}

export const useTripStore = create<TripState>((set) => ({
  trips: [],
  activeTripId: null,
  online: navigator.onLine,
  loadTrips: async () => {
    set({ trips: await db.listTrips() });
  },
  openTrip: (id) => set({ activeTripId: id }),
  closeTrip: () => set({ activeTripId: null }),
  setOnline: (on) => set({ online: on }),
}));