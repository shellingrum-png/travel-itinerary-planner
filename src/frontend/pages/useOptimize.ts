import { useState } from 'react';
import { solveTsp, savings } from '../utils/tsp';
import { useDayStore } from '../stores/dayStore';
import type { ItineraryItem, Poi, Hotel } from '../types';
import { getDuration } from '../services/amap';

interface OptimizeState {
  loading: boolean;
  preview: { newOrder: number[]; savedMinutes: number } | null;
  error: string | null;
}

export function useOptimize() {
  const { items, optimize, confirmOptimize, undo, canUndo, reorder } = useDayStore();
  const [state, setState] = useState<OptimizeState>({ loading: false, preview: null, error: null });

  const runOptimize = async (dayId: string) => {
    setState({ loading: true, preview: null, error: null });
    try {
      const sorted = [...items].sort((a, b) => a.orderSeq - b.orderSeq);
      if (sorted.length < 2) {
        setState({ loading: false, preview: null, error: '景点太少,无需优化' });
        return;
      }

      // 加载所有 POI 坐标
      const { db } = await import('../services/db');
      const poiMap = new Map<string, Poi>();
      const itemPois: (Poi | null)[] = await Promise.all(
        sorted.map(async (it) => {
          if (!it.poiId) return null;
          let p = poiMap.get(it.poiId);
          if (!p) {
            const fetched = await db.getPoi(it.poiId);
            if (fetched) {
              poiMap.set(it.poiId, fetched);
              p = fetched;
            }
          }
          return p ?? null;
        }),
      );

      // 检查是否有有效坐标
      const validCount = itemPois.filter((p) => p && p.lng !== 0 && p.lat !== 0).length;
      if (validCount < 2) {
        setState({ loading: false, preview: null, error: '景点坐标不足,无法优化' });
        return;
      }

      // 获取当天酒店作为起点/终点(索引 0)
      // 简化:从当前 day 的 tripId 查酒店;若当天有酒店用酒店坐标,否则用第一个有效景点
      const day = await db.getDay(dayId);
      let hotelPoi: Poi | null = null;
      if (day) {
        const hotels = await (db as any).listHotels?.(day.tripId) ?? [];
        const dayHotel = hotels.find((h: Hotel) => h.checkIn === day.date || h.checkOut === day.date);
        if (dayHotel && dayHotel.lng && dayHotel.lat) {
          hotelPoi = {
            id: `hotel-${dayHotel.id}`,
            name: dayHotel.name,
            lng: dayHotel.lng,
            lat: dayHotel.lat,
            category: 'hotel',
          };
        }
      }

      // 构建坐标数组:索引 0 = 酒店/起点, 1..n = 景点
      const coords: (Poi | null)[] = [hotelPoi];
      for (const p of itemPois) coords.push(p);

      // 构建耗时矩阵(含缓存)
      const durationMatrix: number[][] = [];
      const n = coords.length;
      for (let i = 0; i < n; i++) {
        durationMatrix[i] = new Array(n).fill(0);
      }

      // 批量获取路径(控制并发 ≤5)
      const tasks: { i: number; j: number; from: Poi; to: Poi; mode: string }[] = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const from = coords[i];
          const to = coords[j];
          if (!from || !to || from.lng === 0 || from.lat === 0 || to.lng === 0 || to.lat === 0) {
            durationMatrix[i][j] = 15; // 默认 15min
            continue;
          }
          // j 的 transportMode 表示从上一节点到 j 的方式
          const mode = j >= 1 ? sorted[j - 1].transportMode : 'walk';
          tasks.push({ i, j, from, to, mode });
        }
      }

      // 并发控制:每批最多 5 个
      const BATCH = 5;
      for (let b = 0; b < tasks.length; b += BATCH) {
        const batch = tasks.slice(b, b + BATCH);
        const results = await Promise.all(
          batch.map((t) =>
            getDuration([t.from.lng, t.from.lat], [t.to.lng, t.to.lat], t.mode as any).catch(() => ({
              durationMin: 15,
              distanceM: 0,
            })),
          ),
        );
        batch.forEach((t, idx) => {
          durationMatrix[t.i][t.j] = results[idx].durationMin;
        });
      }

      const count = coords.length;
      const duration = (i: number, j: number): number => {
        return durationMatrix[i]?.[j] ?? 15;
      };

      const result = solveTsp({ count, duration });
      const currentOrder = sorted.map((_, i) => i);
      const saved = result.order.length === currentOrder.length
        ? savings(currentOrder, result.order, duration)
        : 0;

      optimize();
      setState({
        loading: false,
        preview: { newOrder: result.order, savedMinutes: saved },
        error: null,
      });
    } catch (e: any) {
      setState({ loading: false, preview: null, error: e.message || '优化失败' });
    }
  };

  const handleConfirm = async (dayId: string) => {
    if (!state.preview) return;
    const sorted = [...items].sort((a, b) => a.orderSeq - b.orderSeq);
    const newOrder = state.preview.newOrder;
    for (let i = 0; i < newOrder.length; i++) {
      const item = sorted[newOrder[i]];
      if (item && item.orderSeq !== i) {
        await reorder(dayId, item.id, i);
      }
    }
    await confirmOptimize();
    setState({ loading: false, preview: null, error: null });
  };

  const handleCancel = () => {
    setState({ loading: false, preview: null, error: null });
  };

  const handleUndo = () => {
    undo();
    setState({ loading: false, preview: null, error: null });
  };

  return {
    ...state,
    canUndo,
    runOptimize,
    handleConfirm,
    handleCancel,
    handleUndo,
  };
}
