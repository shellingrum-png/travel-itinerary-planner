import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { db } from '../services/db';
import { searchTransport, type TransportOption } from '../services/transport';
import type { Transport, TransportModeType, TransportSegmentType, Trip } from '../types';
import { C, btn, btnGhost, btnSmall, card, input, PageHeader, EmptyState } from '../components/ui';

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
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24, minHeight: '100vh' }}>
      <Link to={`/trip/${tripId}`} style={{ color: C.success, fontSize: 13, textDecoration: 'none' }}>&larr; 返回旅程</Link>
      <PageHeader title="大交通管理" right={
        !showForm ? (
          <button onClick={() => { resetForm(); setShowForm(true); }} style={btn()}>+ 添加交通</button>
        ) : undefined
      } />

      {showForm && (
        <div style={{ padding: 16, border: '1px dashed rgba(255,255,255,0.2)', borderRadius: 12, marginBottom: 16, background: 'rgba(255,255,255,0.02)' }}>
          {error && <p style={{ color: C.danger, fontSize: 13, marginTop: 0 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <select value={form.segType} onChange={(e) => setForm({ ...form, segType: e.target.value as TransportSegmentType })} style={{ ...input, width: 'auto' }}>
              {SEG_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <select value={form.mode} onChange={(e) => { setForm({ ...form, mode: e.target.value as TransportModeType }); setResults([]); }} style={{ ...input, width: 'auto' }}>
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input placeholder="出发地" value={form.fromPlace} onChange={(e) => setForm({ ...form, fromPlace: e.target.value })} style={{ ...input, flex: 1 }} />
            <input placeholder="目的地" value={form.toPlace} onChange={(e) => setForm({ ...form, toPlace: e.target.value })} style={{ ...input, flex: 1 }} />
          </div>

          {/* V6.2 真实班次查询 */}
          {(form.mode === 'flight' || form.mode === 'train') && (
            <div style={{ marginBottom: 8, padding: 10, background: 'rgba(22,119,255,0.06)', border: '1px solid rgba(22,119,255,0.15)', borderRadius: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="date" value={queryDate} onChange={(e) => setQueryDate(e.target.value)} style={{ ...input, flex: 1 }} />
                <button onClick={handleSearch} disabled={searching} style={{ ...btnGhost, ...btnSmall, whiteSpace: 'nowrap' }}>{searching ? '查询中…' : '🔍 查询班次'}</button>
              </div>
              {results.length > 0 && (
                <div style={{ maxHeight: 180, overflow: 'auto', marginTop: 8 }}>
                  {results.map((o, i) => (
                    <div key={i} onClick={() => handleSelectOption(o)} style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', fontSize: 13, borderRadius: 6, transition: 'background 0.1s' }} onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                      <strong style={{ color: C.warning }}>{o.train_no || o.flight_no}</strong>{' '}
                      <span>{o.departure_time}→{o.arrival_time} ({o.duration})</span>
                      <span style={{ color: C.success, marginLeft: 6 }}>{o.ticket_price ? `¥${o.ticket_price}` : o.seat_prices?.second_class ? `二等座¥${o.seat_prices.second_class}` : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <input type="datetime-local" value={form.departAt} onChange={(e) => setForm({ ...form, departAt: e.target.value })} style={input} />
            <span style={{ alignSelf: 'center', color: '#6a6a80' }}>→</span>
            <input type="datetime-local" value={form.arriveAt} onChange={(e) => setForm({ ...form, arriveAt: e.target.value })} style={input} />
          </div>

          {(form.mode === 'flight' || form.mode === 'train') && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input placeholder={form.mode === 'flight' ? '航班号 (如 ZH9123)' : '车次 (如 G1234)'} value={form.mode === 'flight' ? form.flightNo : form.trainNo} onChange={(e) => setForm({ ...form, [form.mode === 'flight' ? 'flightNo' : 'trainNo']: e.target.value })} style={{ ...input, flex: 1 }} />
              <input type="number" placeholder="票价(选填)" value={price} onChange={(e) => setPrice(e.target.value)} style={{ ...input, width: 120 }} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSubmit} style={btn()}>{editId ? '保存修改' : '确认添加'}</button>
            <button onClick={() => { setShowForm(false); resetForm(); }} style={btnGhost}>取消</button>
          </div>
        </div>
      )}

      {transports.length === 0 ? (
        <EmptyState>暂无交通记录</EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {transports.map((t) => (
            <div key={t.id} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {MODES.find((m) => m.value === t.mode)?.label} {t.flightNo || t.trainNo || ''}
                    {' '}<span style={{ fontSize: 12, color: '#6a6a80', fontWeight: 400 }}>{SEG_TYPES.find((s) => s.value === t.segType)?.label}</span>
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>{t.fromPlace} → {t.toPlace}</div>
                  <div style={{ fontSize: 12, color: '#9a9ab2', marginTop: 2 }}>{formatTime(t.departAt)} → {formatTime(t.arriveAt)}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => handleEdit(t)} style={{ ...btnGhost, ...btnSmall }}>编辑</button>
                  <button onClick={() => handleDelete(t.id)} style={{ ...btnGhost, ...btnSmall, color: C.danger }}>删除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}