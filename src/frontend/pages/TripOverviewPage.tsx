import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { db } from '../services/db';
import { computeTripOverview, type TripOverview } from '../utils/dayStats';
import type { Trip, ItineraryDay, ItineraryItem, Poi, Hotel, Expense, Transport, RouteCache } from '../types';
import { C, card } from '../components/ui';

const CATEGORY_LABEL: Record<string, string> = {
  transport: '大交通',
  hotel: '住宿',
  food: '餐饮',
  ticket: '门票',
  local_traffic: '本地交通',
  other: '其他',
};

export default function TripOverviewPage() {
  const { id: tripId } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [overview, setOverview] = useState<TripOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!tripId) return;
    try {
      const t = await db.getTrip(tripId);
      if (!t) return;
      setTrip(t);
      const days = await db.listDays(tripId);
      // 收集每日 items、相关 poi、缓存、酒店、交通、花费
      const itemsByDay: Record<string, ItineraryItem[]> = {};
      const poiIds = new Set<string>();
      for (const d of days) {
        const its = await db.listItems(d.id);
        itemsByDay[d.id] = its;
        for (const it of its) if (it.poiId) poiIds.add(it.poiId);
      }
      const pois: Poi[] = [];
      for (const pid of poiIds) {
        const p = await db.getPoi(pid);
        if (p) pois.push(p);
      }
      const hotels = await db.listHotels(tripId);
      const transports = await db.listTransports(tripId);
      const expenses = await db.listExpenses(tripId);
      const routeCache = await db.listRouteCache();

      setOverview(computeTripOverview({
        trip: t, days, itemsByDay, pois, hotels, transports, expenses, routeCache,
      }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [tripId]);

  if (loading) return <p style={{ textAlign: 'center', color: '#9a9ab0', padding: 40 }}>加载中…</p>;
  if (!trip || !overview) return <p style={{ textAlign: 'center', color: '#9a9ab0', padding: 40 }}>未找到旅程</p>;

  const catEntries = Object.entries(overview.spendByCategory).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...catEntries.map(([, v]) => v));

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24, minHeight: '100vh' }}>
      <Link to={`/trip/${tripId}`} style={{ color: '#06d6a0', fontSize: 13, textDecoration: 'none' }}>&larr; 返回旅程</Link>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>数据概览</h1>
      <p style={{ color: '#9a9ab0', fontSize: 13, marginTop: 4 }}>
        {trip.title} · {trip.startDate} ~ {trip.endDate} · {trip.companionCount}人
      </p>

      {/* 总花费 */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 13, color: '#9a9ab0' }}>总花费</div>
            <div style={{ fontSize: 30, fontWeight: 700, color: C.warning }}>
              ¥{overview.totalSpend.toFixed(0)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13, color: '#9a9ab0' }}>人均</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>¥{overview.perCapita.toFixed(0)}</div>
          </div>
        </div>
        {/* 分类占比 */}
        {catEntries.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {catEntries.map(([cat, val]) => (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ width: 70, color: '#e8e8f0' }}>{CATEGORY_LABEL[cat] ?? cat}</span>
                <div style={{ flex: 1, height: 8, background: 'rgba(255,255,255,0.08)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(val / maxCat) * 100}%`, background: C.primary, borderRadius: 4 }} />
                </div>
                <span style={{ width: 60, textAlign: 'right', color: '#9a9ab0' }}>¥{val.toFixed(0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 逐日卡片 */}
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 12px' }}>每日明细</h2>
      {overview.dayStats.length === 0 ? (
        <p style={{ color: '#9a9ab0' }}>暂无日期数据</p>
      ) : (
        overview.dayStats.map((d) => (
          <div key={d.daySeq} style={{ ...card, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 15 }}>Day {d.daySeq} · {d.date}</strong>
              <span style={{ fontSize: 13, color: C.info }}>
                🚗 {d.driveKm.toFixed(1)} km{d.driveKmApprox ? ' ≈' : ''}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: d.pois.length ? 8 : 0 }}>
              <span style={{ fontSize: 13 }}>🏨 {d.hotelName}</span>
            </div>
            {d.pois.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {d.pois.map((p, i) => (
                  <span key={i} style={{
                    fontSize: 12, color: '#e8e8f0', background: 'rgba(255,255,255,0.07)',
                    border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '2px 8px',
                  }}>
                    {p.name}
                  </span>
                ))}
              </div>
            ) : (
              <span style={{ fontSize: 13, color: '#9a9ab0' }}>当日无景点排点</span>
            )}
            {d.spend > 0 && <div style={{ marginTop: 8, fontSize: 13, color: '#9a9ab0' }}>当日花费 ¥{d.spend.toFixed(0)}</div>}
          </div>
        ))
      )}
    </div>
  );
}
