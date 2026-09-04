import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { db } from '../services/db';
import type { Transport, TransportModeType, TransportSegmentType } from '../types';

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
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!tripId) return;
    setTransports(await db.listTransports(tripId));
  };

  useEffect(() => { load(); }, [tripId]);

  const resetForm = () => {
    setForm({ segType: 'inter_city', mode: 'flight', fromPlace: '', toPlace: '', departAt: '', arriveAt: '', flightNo: '', trainNo: '' });
    setError(null);
    setEditId(null);
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

    if (editId) {
      await db.updateTransport(editId, form);
    } else {
      await db.addTransport({ tripId, ...form });
    }
    resetForm();
    setShowForm(false);
    await load();
  };

  const handleEdit = (t: Transport) => {
    setForm({
      segType: t.segType,
      mode: t.mode,
      fromPlace: t.fromPlace ?? '',
      toPlace: t.toPlace ?? '',
      departAt: t.departAt.slice(0, 16),
      arriveAt: t.arriveAt.slice(0, 16),
      flightNo: t.flightNo ?? '',
      trainNo: t.trainNo ?? '',
    });
    setEditId(t.id);
    setShowForm(true);
    setError(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此交通记录?')) return;
    await db.removeTransport(id);
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
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <select value={form.segType} onChange={(e) => setForm({ ...form, segType: e.target.value as TransportSegmentType })}>
              {SEG_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as TransportModeType })}>
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input placeholder="出发地" value={form.fromPlace} onChange={(e) => setForm({ ...form, fromPlace: e.target.value })} style={{ flex: 1 }} />
            <input placeholder="目的地" value={form.toPlace} onChange={(e) => setForm({ ...form, toPlace: e.target.value })} style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input type="datetime-local" value={form.departAt} onChange={(e) => setForm({ ...form, departAt: e.target.value })} />
            <span style={{ alignSelf: 'center' }}>→</span>
            <input type="datetime-local" value={form.arriveAt} onChange={(e) => setForm({ ...form, arriveAt: e.target.value })} />
          </div>
          {(form.mode === 'flight' || form.mode === 'train') && (
            <div style={{ marginBottom: 8 }}>
              <input
                placeholder={form.mode === 'flight' ? '航班号 (如 ZH9123)' : '车次 (如 G1234)'}
                value={form.mode === 'flight' ? form.flightNo : form.trainNo}
                onChange={(e) => setForm({ ...form, [form.mode === 'flight' ? 'flightNo' : 'trainNo']: e.target.value })}
              />
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
                  <div style={{ fontSize: 14, marginTop: 4 }}>
                    {t.fromPlace} → {t.toPlace}
                  </div>
                  <div style={{ fontSize: 13, color: '#888', marginTop: 2 }}>
                    {formatTime(t.departAt)} → {formatTime(t.arriveAt)}
                  </div>
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