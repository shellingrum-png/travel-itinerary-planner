import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
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
import AuthPage from './pages/AuthPage';
import { onAuthStateChange, isAuthConfigured } from './services/auth';
import { db } from './services/db';

export default function App() {
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [booting, setBooting] = useState(true);

  const handleUser = async (u: { id: string; email?: string } | null) => {
    setUser(u);
    if (u) {
      await db.clearAll();
      try {
        const { reconcile } = await import('./services/sync');
        await reconcile();
      } catch { /* 云端不可用时静默,至少本地是新的 */ }
    } else {
      await db.clearAll();
    }
  };

  useEffect(() => {
    if (!isAuthConfigured()) { setUser({ id: 'anon', email: 'anonymous@local' }); setBooting(false); return; }
    let first = true;
    const sub = onAuthStateChange((u) => {
      if (first) { setUser(u); setBooting(false); first = false; return; }
      handleUser(u);
    });
    return () => sub.unsubscribe();
  }, []);

  if (booting) return <div style={{ textAlign: 'center', color: '#9a9ab0', padding: 60 }}>加载中…</div>;

  const showApp = !isAuthConfigured() || user;

  return (
    <>
      {!showApp && <AuthPage />}
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
