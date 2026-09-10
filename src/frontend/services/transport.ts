/**
 * 交通查询服务(V6.2)
 * 前端封装:调用后端 server/index.js 的 /api/transport,查询国内航班/高铁真实班次
 * 后端地址:本地 http://localhost:8766,可通过 VITE_TRANSPORT_API 覆盖
 */
import type { Trip } from '../types';

// VITE_TRANSPORT_API 是「源站」:未配置→本地 8766;配置为空→同源(生产经 Nginx 反代 /api)
const TRANSPORT_ORIGIN = import.meta.env.VITE_TRANSPORT_API ?? 'http://localhost:8766';
const BASE = `${TRANSPORT_ORIGIN}/api`;

/** 查询结果 option(航班/高铁通用关键字段) */
export interface TransportOption {
  // 通用
  departure_time: string;
  arrival_time: string;
  duration: string;
  // 高铁
  train_no?: string;
  train_type?: string;
  train_class_name?: string;
  seat_prices?: Record<string, number | null>;
  // 航班
  flight_no?: string;
  airline_name?: string;
  equipment?: string;
  ticket_price?: number;
  departure_name?: string;
  arrival_name?: string;
}

export interface TransportResponse {
  ok?: boolean;
  mode?: string;
  provider?: string;
  error?: string;
  outbound?: {
    route?: { from?: { code?: string; name?: string }; to?: { code?: string; name?: string }; date?: string };
    count?: number;
    total_found?: number;
    options?: TransportOption[];
  };
}

export async function searchTransport(
  mode: 'train' | 'flight',
  from: string,
  to: string,
  date: string,
): Promise<TransportOption[]> {
  const url = `${BASE}/transport?mode=${mode}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${date}`;
  const res = await fetch(url);
  const json = (await res.json()) as TransportResponse;
  if (!json.ok || json.error) {
    throw new Error(json.error || '查询失败');
  }
  return json.outbound?.options || [];
}

/** 便捷:查高铁 */
export function searchTrain(from: string, to: string, date: string) {
  return searchTransport('train', from, to, date);
}

/** 便捷:查航班 */
export function searchFlight(from: string, to: string, date: string) {
  return searchTransport('flight', from, to, date);
}

/** 判定行程目的地是否需要大交通(多城市或跨城) */
export function needsLongTransport(trip: Trip | null): boolean {
  return !!(trip?.cityNodes && trip.cityNodes.length >= 2);
}