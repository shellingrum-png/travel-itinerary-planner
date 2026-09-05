import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { db } from '../services/db';
import { searchTransport, type TransportOption } from '../services/transport';
import type { Transport, TransportModeType, TransportSegmentType, Trip } from '../types';

const MODES: { value: TransportModeType; label: string }[] = [
  { value: 'flight', label: '飞机' },
  { value: 'train', label: '高铁/火车' },
  { value: 'drive', label: '自驾' },
  { value: 'ferry', label: '轮渡' },
];

const SEG_TYPES: { value: TransportSegmentType; label: string }[] = [
  { value: 'round_trip', label: '往返' },
  { value: 'inter_city', label: '城市间' },
];

export default function TransportPage() {
  const { id: tripId } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [transports, setTransports] = useState<Transport[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({
    segType: 'inter_city' as TransportSegmentType,
    mode: 'flight' as TransportModeType,
    fromPlace: '',
    toPlace: '',
    departAt: '',
    arriveAt: '',
    flightNo: '',
    trainNo: '',
  });
  const [price, setPrice] = useState('');         // V6.2 关联记账:票价
  const [error, setError] = useState<string | null>(null);

  // V6.2 真实班次查询
  const [results, setResults] = useState<TransportOption[]>([]);
  const [queryDate, setQueryDate] = useState(new Date().toISOString().slice(0, 10));
  const [searching, setSearching] = useState(false);

  const load = async () => {
    if (!tripId) return;
    setTrip(await db.getTrip(tripId));
    setTransports(await db.listTransports(tripId));
  };

  useEffect(() => { load(); }, [tripId]);

  const resetForm = () => {
    setForm({ segType: 'inter_city', mode: 'flight', fromPlace: '', toPlace: '', departAt: '', arriveAt: '', flightNo: '', trainNo: '' });
    setPrice(''); setResults([]); setError(null); setEditId(null);
  };

  // V6.2 查询真实班次
  const handleSearch = async () => {
    if (!form.fromPlace || !form.toPlace) { setError('请先填出发地/目的地'); return; }
    setSearching(true); setError(null); setResults([]);
    try {
      const mode = form.mode === 'flight' ? 'flight' : form.mode === 'train' ? 'train' : null;
      if (!mode) { setError('自驾/轮渡不支持班次查询,请手动填起止时间'); return; }
      const opts = await searchTransport(mode, form.fromPlace, form.toPlace, queryDate);
      setResults(opts);
      if (opts.length === 0) setError('未查询到班次,请换日期或核对城市');
    } catch (e: any) {
      setError('查询失败: ' + (e?.message || '服务未启动?请先运行 start-dev.sh'));
    } finally { setSearching(false); }
  };

  // V6.2 选中班次 → 回填起止时刻 + 班次号
  const handleSelectOption = (o: TransportOption) => {
    setForm((f) => ({
      ...f,
      departAt: `${queryDate}T${o.departure_time}`,
      arriveAt: `${queryDate}T${o.arrival_time}`,
      flightNo: o.flight_no || '',
      trainNo: o.train_no || '',
    }));
    // 回填票价(高铁取二等座,航班取 ticket_price)
    const p = o.ticket_price ?? o.seat_prices?.second_class ?? o.seat_prices?.first_class ?? '';
    setPrice(p ? String(p) : '');
    setResults([]);
  };

  const handleSubmit = async () => {
    if (!tripId) return;
    if (!form.fromPlace || !form.toPlace || !form.departAt || !form.arriveAt) {
      setError('请填写出发地、目的地、出发时间和到达时间');
      return;
    }
    if (form.departAt >= form.arriveAt) {
      setError('到达时间必须晚于出发时间');
      return;
    }

    let transportId = '';
    if (editId) {
      await db.updateTransport(editId, form);
      transportId = editId;
    } else {
      const created = await db.addTransport({ tripId, ...form });
      transportId = created.id;
    }
    // V6.2 联动记账:票价
    const p = parseFloat(price);
    if (!isNaN(p) && p > 0 && tripId) {
      const label = `${form.flightNo || form.trainNo || ''} ${form.fromPlace}→${form.toPlace}`.trim();
      const date = form.departAt.slice(0, 10);
      await db.addExpense({
        tripId, category: 'transport', amount: p,
        currency: trip?.currency ?? 'CNY', date,
        note: `大交通 · ${label}`,
        refType: 'transport', refId: transportId,
      });
    }
    resetForm();
    setShowForm(false);
    await load();
  };

  const handleEdit = (t: Transport) => {
    setForm({
      segType: t.segType, mode: t.mode,
      fromPlace: t.fromPlace ?? '', toPlace: t.toPlace ?? '',
      departAt: t.departAt.slice(0, 16), arriveAt: t.arriveAt.slice(0, 16),
      flightNo: t.flightNo ?? '', trainNo: t.trainNo ?? '',
    });
    setEditId(t.id); setShowForm(true); setError(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此交通记录?(关联记账一并删除)')) return;
    await db.removeTransport(id);
    // V6.2 联动删除关联记账
    const exps = await db.listExpenses(tripId!);
    for (const e of exps.filter((x) => x.refType === 'transport' && x.refId === id)) await db.removeExpense(e.id);
    await load();
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
      <Link to={`/trip/${tripId}`}>&larr; 返回旅程</Link>
      <h1>大交通管理</h1>

      {!showForm ? (
        <button onClick={() => { resetForm(); setShowForm(true); }}>+ 添加交通</button>
      ) : (
        <div style={{ padding: 12, border: '1px dashed #ccc', borderRadius: 8, marginBottom: 16 }}>
          {error && <p style={{ color: '#c00', fontSize: 13 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <select value={form.segType} onChange={(e) => setForm({ ...form, segType: e.target.value as TransportSegmentType })}>
              {SEG_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <select value={form.mode} onChange={(e) => { setForm({ ...form, mode: e.target.value as TransportModeType }); setResults([]); }}>
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input placeholder="出发地" value={form.fromPlace} onChange={(e) => setForm({ ...form, fromPlace: e.target.value })} style={{ flex: 1 }} />
            <input placeholder="目的地" value={form.toPlace} onChange={(e) => setForm({ ...form, toPlace: e.target.value })} style={{ flex: 1 }} />
          </div>

          {/* V6.2 真实班次查询 */}
          {(form.mode === 'flight' || form.mode === 'train') && (
            <div style={{ marginBottom: 8, padding: 8, background: '#f7f7f7', borderRadius: 6 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="date" value={queryDate} onChange={(e) => setQueryDate(e.target.value)} style={{ flex: 1 }} />
                <button onClick={handleSearch} disabled={searching}>{searching ? '查询中…' : '🔍 查询班次'}</button>
              </div>
              {results.length > 0 && (
                <div style={{ maxHeight: 180, overflow: 'auto', marginTop: 8 }}>
                  {results.map((o, i) => (
                    <div key={i} onClick={() => handleSelectOption(o)} style={{ padding: '6px 8px', borderBottom: '1px solid #eee', cursor: 'pointer', fontSize: 13 }}>
                      <strong>{o.train_no || o.flight_no}</strong>{' '}
                      {o.departure_time}→{o.arrival_time} ({o.duration})
                      {o.ticket_price ? ` · ¥${o.ticket_price}` : o.seat_prices?.second_class ? ` · 二等座¥${o.seat_prices.second_class}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input type="datetime-local" value={form.departAt} onChange={(e) => setForm({ ...form, departAt: e.target.value })} />
            <span style={{ alignSelf: 'center' }}>→</span>
            <input type="datetime-local" value={form.arriveAt} onChange={(e) => setForm({ ...form, arriveAt: e.target.value })} />
          </div>

          {(form.mode === 'flight' || form.mode === 'train') && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                placeholder={form.mode === 'flight' ? '航班号 (如 ZH9123)' : '车次 (如 G1234)'}
                value={form.mode === 'flight' ? form.flightNo : form.trainNo}
                onChange={(e) => setForm({ ...form, [form.mode === 'flight' ? 'flightNo' : 'trainNo']: e.target.value })}
                style={{ flex: 1 }}
              />
              <input type="number" placeholder="票价(选填)" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 140 }} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSubmit}>{editId ? '保存修改' : '确认添加'}</button>
            <button onClick={() => { setShowForm(false); resetForm(); }}>取消</button>
          </div>
        </div>
      )}

      {transports.length === 0 ? (
        <p style={{ color: '#aaa' }}>暂无交通记录</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {transports.map((t) => (
            <li key={t.id} style={{ padding: 10, border: '1px solid #eee', borderRadius: 6, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 'bold' }}>
                    {MODES.find((m) => m.value === t.mode)?.label} {t.flightNo || t.trainNo || ''}
                    {' '}<span style={{ fontSize: 12, color: '#888' }}>{SEG_TYPES.find((s) => s.value === t.segType)?.label}</span>
                  </div>
                  <div style={{ fontSize: 14, marginTop: 4 }}>{t.fromPlace} → {t.toPlace}</div>
                  <div style={{ fontSize: 13, color: '#888', marginTop: 2 }}>{formatTime(t.departAt)} → {formatTime(t.arriveAt)}</div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => handleEdit(t)} style={{ fontSize: 12 }}>编辑</button>
                  <button onClick={() => handleDelete(t.id)} style={{ fontSize: 12, color: '#c00' }}>删除</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}