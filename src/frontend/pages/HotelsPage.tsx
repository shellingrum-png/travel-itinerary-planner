import { useEffect, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { db } from '../services/db';
import { loadAMap } from '../services/amapLoader';
import { C, btn, btnGhost, btnSmall, card, input, PageHeader, EmptyState } from '../components/ui';
import type { Hotel, Trip, ItineraryItem, Expense } from '../types';

const DEFAULT_LNG = 116.397;
const DEFAULT_LAT = 39.908;

export default function HotelsPage() {
  const { id: tripId } = useParams<{ id: string }>();
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [items, setItems] = useState<ItineraryItem[]>([]); // 全旅程 items,用于按 poiId 关联费用
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
  // 费用(并入编辑表单)
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState('');
  const [expenseNote, setExpenseNote] = useState('');
  const [hadExpense, setHadExpense] = useState(false);
  const [clearExpense, setClearExpense] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);

  const load = async () => {
    if (!tripId) return;
    setHotels(await db.listHotels(tripId));
    setTrip(await db.getTrip(tripId));
    setExpenses(await db.listExpenses(tripId));
    // 收集全旅程 hotel item,用于按 poiId 匹配酒店 → 关联费用
    const days = await db.listDays(tripId);
    const all: ItineraryItem[] = [];
    for (const d of days) all.push(...(await db.listItems(d.id)));
    setItems(all);
  };

  useEffect(() => { load(); }, [tripId]);

  const resetForm = () => {
    setForm({ name: '', address: '', lng: '', lat: '', checkIn: '', checkOut: '', checkInTime: '14:00', checkOutTime: '12:00' });
    setError(null);
    setEditId(null);
    setPickingCoords(false);
    setExpenseAmount(''); setExpenseDate(''); setExpenseNote('');
    setHadExpense(false); setClearExpense(false);
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

    // 费用(仅编辑模式可关联:酒店通过 poiId 匹配日程 item → 记账)
    if (editId) {
      const current = hotels.find((h) => h.id === editId);
      const item = current ? items.find((x) => x.itemType === 'hotel' && x.poiId === current.poiId) : null;
      if (item) {
        const linked = expenses.find((e) => e.refType === 'itinerary_item' && e.refId === item.id && e.category === 'hotel');
        if (clearExpense) {
          if (linked) await db.removeExpense(linked.id);
        } else {
          const ea = parseFloat(expenseAmount);
          if (!isNaN(ea) && ea > 0) {
            const upd: Partial<Expense> = { amount: ea };
            if (expenseDate) upd.date = expenseDate;
            if (expenseNote.trim()) upd.note = expenseNote.trim();
            if (linked) await db.updateExpense(linked.id, upd);
            else {
              const exp: Omit<Expense, 'id' | 'dirty'> = {
                tripId, category: 'hotel', amount: ea, currency: trip?.currency ?? 'CNY',
                refType: 'itinerary_item', refId: item.id, dayId: item.dayId,
              };
              if (expenseDate) exp.date = expenseDate;
              if (expenseNote.trim()) exp.note = expenseNote.trim();
              await db.addExpense(exp);
            }
          }
        }
      }
    }

    resetForm();
    setShowForm(false);
    await load();
  };

  const handleEdit = async (h: Hotel) => {
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
    // 预取费用
    const item = items.find((x) => x.itemType === 'hotel' && x.poiId === h.poiId);
    const linked = item ? expenses.find((e) => e.refType === 'itinerary_item' && e.refId === item.id && e.category === 'hotel') : undefined;
    setExpenseAmount(linked ? String(linked.amount) : '');
    setExpenseDate(linked?.date ?? '');
    setExpenseNote(linked?.note ?? '');
    setHadExpense(!!linked);
    setClearExpense(false);
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
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <Link to={`/trip/${tripId}`} style={{ color: C.success, fontSize: 13 }}>&larr; 返回旅程</Link>
      <PageHeader title="酒店管理" right={
        !showForm ? (
          <button onClick={() => { resetForm(); setShowForm(true); }} style={btn(C.primary)}>+ 添加酒店</button>
        ) : undefined
      } />

      {showForm && (
        <div style={{ ...card, borderStyle: 'dashed', marginBottom: 16 }}>
          {error && <p style={{ color: C.danger, fontSize: 13, marginTop: 0 }}>{error}</p>}
          <div style={{ marginBottom: 8 }}>
            <input placeholder="酒店名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ ...input, width: '100%' }} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <input placeholder="地址" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} style={{ ...input, width: '100%' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input placeholder="经度" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} style={{ ...input, flex: 1 }} />
            <input placeholder="纬度" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} style={{ ...input, flex: 1 }} />
            <button onClick={() => setPickingCoords(!pickingCoords)} style={{ ...btnGhost, ...btnSmall, whiteSpace: 'nowrap' }}>
              {pickingCoords ? '关闭地图' : '地图选点'}
            </button>
          </div>
          {pickingCoords && (
            <div ref={mapContainerRef} style={{ width: '100%', height: 260, marginBottom: 8, borderRadius: 8, overflow: 'hidden' }} />
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <div>
              <label style={{ fontSize: 12, color: '#9a9ab2', display: 'block', marginBottom: 4 }}>入住日期</label>
              <input type="date" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} style={input} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#9a9ab2', display: 'block', marginBottom: 4 }}>退房日期</label>
              <input type="date" value={form.checkOut} onChange={(e) => setForm({ ...form, checkOut: e.target.value })} style={input} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#9a9ab2', display: 'block', marginBottom: 4 }}>入住时间</label>
              <input type="time" value={form.checkInTime} onChange={(e) => setForm({ ...form, checkInTime: e.target.value })} style={input} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#9a9ab2', display: 'block', marginBottom: 4 }}>退房时间</label>
              <input type="time" value={form.checkOutTime} onChange={(e) => setForm({ ...form, checkOutTime: e.target.value })} style={input} />
            </div>
          </div>
          {editId && (
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: '#9a9ab2', display: 'block', marginBottom: 4 }}>费用(元,选填)</label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input type="number" min="0" step="0.01" placeholder="金额" value={expenseAmount} onChange={(e) => { setExpenseAmount(e.target.value); setClearExpense(false); }} style={{ ...input, flex: 1 }} />
                <input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} style={{ ...input, width: '50%' }} />
              </div>
              <input placeholder="备注(选填)" value={expenseNote} onChange={(e) => setExpenseNote(e.target.value)} style={{ ...input, marginBottom: 6 }} />
              {hadExpense && (
                <button onClick={() => setClearExpense(true)} style={{ ...btnGhost, ...btnSmall, color: C.danger, borderColor: 'rgba(255,107,107,0.3)' }}>删除费用</button>
              )}
              {clearExpense && <div style={{ fontSize: 12, color: C.danger, marginTop: 4 }}>保存后将删除这笔费用。</div>}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSubmit} style={btn()}>{editId ? '保存修改' : '确认添加'}</button>
            <button onClick={() => { setShowForm(false); resetForm(); }} style={btnGhost}>取消</button>
          </div>
        </div>
      )}

      {hotels.length === 0 ? (
        <EmptyState>暂无酒店记录</EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {hotels.map((h) => (
            <div key={h.id} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{h.name}</div>
                  {h.address && <div style={{ fontSize: 12, color: '#6a6a80', marginTop: 2 }}>{h.address}</div>}
                  <div style={{ fontSize: 12, color: '#9a9ab2', marginTop: 6 }}>
                    {h.checkIn && `入住 ${h.checkIn}`}
                    {h.checkInTime && ` ${h.checkInTime}`}
                    {h.checkOut && ` → 退房 ${h.checkOut}`}
                    {h.checkOutTime && ` ${h.checkOutTime}`}
                  </div>
                  {h.lng != null && h.lat != null && (
                    <div style={{ fontSize: 11, color: '#5a5a70', marginTop: 3 }}>坐标: {h.lng.toFixed(4)}, {h.lat.toFixed(4)}</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                  <button onClick={() => handleEdit(h)} style={{ ...btnGhost, ...btnSmall }}>编辑</button>
                  <button onClick={() => handleDelete(h.id)} style={{ ...btnGhost, ...btnSmall, color: C.danger }}>删除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}