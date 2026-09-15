import { useEffect, useState } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import TripList from './pages/TripList';
import TripDetail from './pages/TripDetail';
import DayTimeline from './pages/DayTimeline';
import PoiSearch from './pages/PoiSearch';
import PoiDetail from './pages/PoiDetail';
import Bookkeeping from './pages/Bookkeeping';
import StagedPage from './pages/StagedPage';
import TransportPage from './pages/TransportPage';
import HotelsPage from './pages/HotelsPage';
import OptimizePage from './pages/OptimizePage';
import TripOverviewPage from './pages/TripOverviewPage';
import ShareView from './pages/ShareView';
import AuthPage from './pages/AuthPage';
import { onAuthStateChange, isAuthConfigured } from './services/auth';
import { setActiveDb, migrateLegacyDb } from './services/db';

export default function App() {
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [booting, setBooting] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const location = useLocation();
  // 分享页免登录:家人凭 token 访问,不经过整站登录门
  const isShare = location.pathname.startsWith('/share');

  const handleUser = async (u: { id: string; email?: string } | null) => {
    // 先切库再更新用户态,避免组件在这中间读到上一个账号的数据
    await setActiveDb(u?.id ?? null);
    setUser(u);
    if (u) {
      // 老版本把数据存在单库里,首次登录时整体迁移过去,避免历史数据"消失"
      await migrateLegacyDb(u.id);
      try {
        const { reconcile, healAllLocalTrips } = await import('./services/sync');
        const r = await reconcile();
        if (r.failed > 0) {
          // 带上具体旅程与原因,便于定位(此前只报「N 个失败」不知道是哪个)
          const detail = r.failures
            .map((f) => `${f.tripId.slice(0, 8)}(${f.action === 'push' ? '上传' : '下载'}): ${f.message}`)
            .join(';');
          setSyncError(`${r.failed} 个旅程同步失败,数据仅保存在本机。原因:${detail.slice(0, 300)}`);
        } else {
          setSyncError(null);
        }
        // 修复历史遗留的账单引用断链(幂等,有修复才回传云端)
        try {
          const healed = await healAllLocalTrips();
          if (healed > 0) console.log(`[sync] 已自愈并回传 ${healed} 个旅程的账单引用`);
        } catch { /* 自愈失败不影响使用 */ }
      } catch (e: any) {
        setSyncError(`云端同步失败:${e?.message || '未知错误'}。数据仍保存在本机。`);
      }
    }
  };

  useEffect(() => {
    if (!isAuthConfigured()) {
      (async () => {
        await setActiveDb(null);
        setUser({ id: 'anon', email: 'anonymous@local' });
        setBooting(false);
      })();
      return;
    }
    let first = true;
    const sub = onAuthStateChange((u) => {
      if (first) {
        // 首次加载:必须先切到该账号的库再渲染,否则会读到错误的库
        first = false;
        (async () => {
          await setActiveDb(u?.id ?? null);
          if (u) await migrateLegacyDb(u.id).catch(() => {});
          setUser(u);
          setBooting(false);
        })();
        return;
      }
      handleUser(u);
    });
    return () => sub.unsubscribe();
  }, []);

  if (booting && !isShare) return <div style={{ textAlign: 'center', color: '#9a9ab0', padding: 60 }}>加载中…</div>;

  const showApp = !isAuthConfigured() || user;

  return (
    <>
      {syncError && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998,
          background: 'rgba(255,107,107,0.95)', color: '#2b0000',
          padding: '8px 16px', fontSize: 13, fontWeight: 600,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        }}>
          <span>⚠️ {syncError}</span>
          <button
            onClick={() => setSyncError(null)}
            style={{ background: 'rgba(0,0,0,0.2)', color: '#2b0000', border: 'none', borderRadius: 6, padding: '2px 10px', cursor: 'pointer', fontWeight: 700 }}
          >
            知道了
          </button>
        </div>
      )}
      {!showApp && !isShare && <AuthPage />}
      {isShare && (
        <Routes>
          <Route path="/share/:token" element={<ShareView />} />
        </Routes>
      )}
      {showApp && (
        <Routes>
          <Route path="/" element={<TripList />} />
          <Route path="/trip/:id" element={<TripDetail />} />
          <Route path="/trip/:id/map" element={<TripDetail />} />
          <Route path="/trip/:id/day/:n" element={<DayTimeline />} />
          <Route path="/trip/:id/day/:n/optimize" element={<OptimizePage />} />
          <Route path="/trip/:id/search" element={<PoiSearch />} />
          <Route path="/trip/:id/poi" element={<PoiDetail />} />
          <Route path="/trip/:id/staged" element={<StagedPage />} />
          <Route path="/trip/:id/transport" element={<TransportPage />} />
          <Route path="/trip/:id/hotels" element={<HotelsPage />} />
          <Route path="/trip/:id/bookkeeping" element={<Bookkeeping />} />
          <Route path="/trip/:id/overview" element={<TripOverviewPage />} />
        </Routes>
      )}
    </>
  );
}
