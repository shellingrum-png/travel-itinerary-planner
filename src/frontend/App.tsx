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

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<TripList />} />
      <Route path="/trip/:id" element={<TripDetail />} />
      {/* /trip/:id/map → redirect to /trip/:id (merged in V5.0) */}
      <Route path="/trip/:id/map" element={<TripDetail />} />
      <Route path="/trip/:id/day/:n" element={<DayTimeline />} />
      <Route path="/trip/:id/day/:n/optimize" element={<OptimizePage />} />
      <Route path="/trip/:id/search" element={<PoiSearch />} />
      <Route path="/trip/:id/poi" element={<PoiDetail />} />
      <Route path="/trip/:id/staged" element={<StagedPage />} />
      <Route path="/trip/:id/transport" element={<TransportPage />} />
      <Route path="/trip/:id/hotels" element={<HotelsPage />} />
      <Route path="/trip/:id/bookkeeping" element={<Bookkeeping />} />
    </Routes>
  );
}