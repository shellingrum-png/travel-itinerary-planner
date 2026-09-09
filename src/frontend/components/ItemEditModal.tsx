import { useState } from 'react';
import { input, btn, btnGhost, btnDanger, C } from './ui';
import { searchPoiByJS, type PoiSearchResult } from '../services/amap';
import type { ItineraryItem, Poi } from '../types';

export interface EditPatch {
  visitMinutes?: number;
  note?: string;
  ticket?: number;
  replacePoi?: PoiSearchResult;
}

interface Props {
  item: (ItineraryItem & { poi?: Poi }) | null;
  defaultCity: string;
  currency: string;
  linkedTicket?: number;
  onCancel: () => void;
  onSave: (patch: EditPatch) => Promise<void>;
}

export default function ItemEditModal({ item, defaultCity, currency, linkedTicket, onCancel, onSave }: Props) {
  const [visitMin, setVisitMin] = useState(item ? String(item.visitMinutes ?? 90) : '');
  const [note, setNote] = useState(item?.note ?? '');
  const [ticket, setTicket] = useState(linkedTicket != null ? String(linkedTicket) : '');
  const [kw, setKw] = useState('');
  const [city, setCity] = useState(defaultCity);
  const [results, setResults] = useState<PoiSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<PoiSearchResult | null>(null);
  const [saving, setSaving] = useState(false);

  if (!item) return null;
  const isPoi = item.itemType === 'poi';

  const doSearch = async () => {
    if (!kw.trim()) return;
    setSearching(true); setResults([]);
    try { setResults(await searchPoiByJS(kw.trim(), city || undefined)); }
    catch { setResults([]); }
    finally { setSearching(false); }
  };

  const confirm = async () => {
    setSaving(true);
    try {
      const vm = visitMin === '' ? undefined : parseInt(visitMin, 10);
      const tk = ticket === '' ? undefined : parseFloat(ticket);
      await onSave({
        visitMinutes: isPoi && vm !== undefined ? (isNaN(vm) ? undefined : vm) : undefined,
        note: note.trim(),
        ticket: isPoi ? tk : undefined,
        replacePoi: isPoi && selected ? selected : undefined,
      });
    } finally { setSaving(false); }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onCancel}
    >
      <div
        style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 20, width: '100%', maxWidth: 440, maxHeight: '85vh', overflow: 'auto', color: '#eee' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <strong style={{ fontSize: 16, color: '#ffd166' }}>修改{item.poi?.name || item.note || '节点'}</strong>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>

        {isPoi && (
          <>
            <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>游览时长(分钟)</label>
            <input type="number" value={visitMin} onChange={(e) => setVisitMin(e.target.value)} style={{ ...input, marginBottom: 10 }} placeholder="如 90" />
            <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>门票价(元)</label>
            <input type="number" value={ticket} onChange={(e) => setTicket(e.target.value)} style={{ ...input, marginBottom: 10 }} placeholder="0 表示免费/不填" />
          </>
        )}

        <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>名称/备注</label>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...input, marginBottom: 10 }} />

        {isPoi && (
          <>
            <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>更换景点</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input type="text" placeholder="搜索景点名" value={kw} onChange={(e) => setKw(e.target.value)} style={{ ...input, flex: 1 }} />
              <input type="text" placeholder="城市(选填)" value={city} onChange={(e) => setCity(e.target.value)} style={{ ...input, width: 110 }} />
              <button onClick={doSearch} disabled={searching} style={{ ...btnGhost, ...btn, padding: '8px 12px', flexShrink: 0 }}>{searching ? '…' : '搜索'}</button>
            </div>
            {selected && <div style={{ fontSize: 12, color: C.success, marginBottom: 6 }}>已选: {selected.name}</div>}
            {results.length > 0 && (
              <div style={{ maxHeight: 160, overflow: 'auto', marginBottom: 6 }}>
                {results.map((r) => (
                  <div key={r.id} onClick={() => { setSelected(r); setResults([]); }} style={{ padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', fontSize: 13, color: selected?.id === r.id ? C.success : '#ddd', borderRadius: 6 }}>
                    {r.name}<span style={{ color: '#888', fontSize: 11 }}> · {r.address}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={confirm} disabled={saving} style={{ ...btn(C.primary), flex: 1 }}>{saving ? '保存中…' : '保存'}</button>
          <button onClick={onCancel} style={{ ...btnGhost, ...btn }}>取消</button>
        </div>
      </div>
    </div>
  );
}
