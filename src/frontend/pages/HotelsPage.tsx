import { useEffect, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { db } from '../services/db';
import { loadAMap } from '../services/amapLoader';
import type { Hotel } from '../types';

const DEFAULT_LNG = 116.397;
const DEFAULT_LAT = 39.908;

export default function HotelsPage() {
  const { id: tripId } = useParams<{ id: string }>();
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    address: '',
    lng: '',
    lat: '',
    checkIn: '',
    checkOut: '',
    checkInTime: '14:00',
    checkOutTime: '12:00',
  });
  const [error, setError] = useState<string | null>(null);
  const [pickingCoords, setPickingCoords] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);

  const load = async () => {
    if (!tripId) return;
    setHotels(await db.listHotels(tripId));
  };

  useEffect(() => { load(); }, [tripId]);

  const resetForm = () => {
    setForm({ name: '', address: '', lng: '', lat: '', checkIn: '', checkOut: '', checkInTime: '14:00', checkOutTime: '12:00' });
    setError(null);
    setEditId(null);
    setPickingCoords(false);
  };

  const handleSubmit = async () => {
    if (!tripId) return;
    if (!form.name) { setError('请填写酒店名称'); return; }

    const data: Omit<Hotel, 'id'> = {
      tripId,
      name: form.name,
      address: form.address || undefined,
      lng: form.lng ? parseFloat(form.lng) : undefined,
      lat: form.lat ? parseFloat(form.lat) : undefined,
      checkIn: form.checkIn || undefined,
      checkOut: form.checkOut || undefined,
      checkInTime: form.checkInTime,
      checkOutTime: form.checkOutTime,
    };

    if (editId) {
      await db.updateHotel(editId, data);
    } else {
      await db.addHotel(data);
    }
    resetForm();
    setShowForm(false);
    await load();
  };

  const handleEdit = (h: Hotel) => {
    setForm({
      name: h.name,
      address: h.address ?? '',
      lng: h.lng != null ? String(h.lng) : '',
      lat: h.lat != null ? String(h.lat) : '',
      checkIn: h.checkIn ?? '',
      checkOut: h.checkOut ?? '',
      checkInTime: h.checkInTime ?? '14:00',
      checkOutTime: h.checkOutTime ?? '12:00',
    });
    setEditId(h.id);
    setShowForm(true);
    setError(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此酒店?')) return;
    await db.removeHotel(id);
    await load();
  };

  const initPickerMap = () => {
    if (!mapContainerRef.current || mapRef.current) return;
    setPickingCoords(true);

    loadAMap().then((AMap) => {
      const lng = form.lng ? parseFloat(form.lng) : DEFAULT_LNG;
      const lat = form.lat ? parseFloat(form.lat) : DEFAULT_LAT;

      const map = new AMap.Map(mapContainerRef.current!, {
        zoom: 13,
        center: [lng, lat],
      });
      mapRef.current = map;

      if (form.lng && form.lat) {
        markerRef.current = new AMap.Marker({ position: [lng, lat] });
        map.add(markerRef.current);
      }

      map.on('click', (e: any) => {
        const { lng, lat } = e.lnglat;
        setForm((f) => ({ ...f, lng: String(lng), lat: String(lat) }));
        if (markerRef.current) map.remove(markerRef.current);
        markerRef.current = new AMap.Marker({ position: [lng, lat] });
        map.add(markerRef.current);
      });
    });
  };

  useEffect(() => {
    if (pickingCoords && !mapRef.current) {
      setTimeout(initPickerMap, 100);
    }
    return () => {
      if (mapRef.current) { mapRef.current.destroy(); mapRef.current = null; }
    };
  }, [pickingCoords]);

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
      <Link to={`/trip/${tripId}`}>&larr; 返回旅程</Link>
      <h1>酒店管理</h1>

      {!showForm ? (
        <button onClick={() => { resetForm(); setShowForm(true); }}>+ 添加酒店</button>
      ) : (
        <div style={{ padding: 12, border: '1px dashed #ccc', borderRadius: 8, marginBottom: 16 }}>
          {error && <p style={{ color: '#c00', fontSize: 13 }}>{error}</p>}
          <div style={{ marginBottom: 8 }}>
            <input placeholder="酒店名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: '100%' }} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <input placeholder="地址" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} style={{ width: '100%' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input placeholder="经度" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} style={{ flex: 1 }} />
            <input placeholder="纬度" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} style={{ flex: 1 }} />
            <button onClick={() => setPickingCoords(!pickingCoords)} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {pickingCoords ? '关闭地图' : '地图选点'}
            </button>
          </div>
          {pickingCoords && (
            <div ref={mapContainerRef} style={{ width: '100%', height: 260, marginBottom: 8, borderRadius: 6, overflow: 'hidden' }} />
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <div>
              <label style={{ fontSize: 12, color: '#888' }}>入住日期</label>
              <input type="date" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#888' }}>退房日期</label>
              <input type="date" value={form.checkOut} onChange={(e) => setForm({ ...form, checkOut: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#888' }}>入住时间</label>
              <input type="time" value={form.checkInTime} onChange={(e) => setForm({ ...form, checkInTime: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#888' }}>退房时间</label>
              <input type="time" value={form.checkOutTime} onChange={(e) => setForm({ ...form, checkOutTime: e.target.value })} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSubmit}>{editId ? '保存修改' : '确认添加'}</button>
            <button onClick={() => { setShowForm(false); resetForm(); }}>取消</button>
          </div>
        </div>
      )}

      {hotels.length === 0 ? (
        <p style={{ color: '#aaa' }}>暂无酒店记录</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {hotels.map((h) => (
            <li key={h.id} style={{ padding: 10, border: '1px solid #eee', borderRadius: 6, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 'bold' }}>{h.name}</div>
                  {h.address && <div style={{ fontSize: 13, color: '#888' }}>{h.address}</div>}
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    {h.checkIn && `入住 ${h.checkIn}`}
                    {h.checkInTime && ` ${h.checkInTime}`}
                    {h.checkOut && ` → 退房 ${h.checkOut}`}
                    {h.checkOutTime && ` ${h.checkOutTime}`}
                  </div>
                  {h.lng != null && h.lat != null && (
                    <div style={{ fontSize: 12, color: '#aaa' }}>坐标: {h.lng.toFixed(4)}, {h.lat.toFixed(4)}</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => handleEdit(h)} style={{ fontSize: 12 }}>编辑</button>
                  <button onClick={() => handleDelete(h.id)} style={{ fontSize: 12, color: '#c00' }}>删除</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}