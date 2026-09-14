/**
 * V12 同行成员管理弹窗
 *
 * 成员名单是分摊与「按人查看」的基础。旧数据(无 members)打开时,
 * 预填 companionCount 个匿名「人1…人N」,直接改名即可,不必从零添加。
 */
import { useState } from 'react';
import { db } from '../services/db';
import { uuid } from '../utils/uuid';
import { effectiveMembers } from '../utils/split';
import type { Trip, TripMember } from '../types';
import { input, btn, btnGhost, C } from './ui';

interface Props {
  trip: Trip;
  onClose: () => void;
  /** 保存成功后回调(调用方刷新自己的 trip 状态) */
  onSaved: (members: TripMember[]) => void;
}

export default function MemberModal({ trip, onClose, onSaved }: Props) {
  const [members, setMembers] = useState<TripMember[]>(() => effectiveMembers(trip).map((m) => ({ ...m })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rename = (id: string, name: string) =>
    setMembers((ms) => ms.map((m) => (m.id === id ? { ...m, name } : m)));

  const addOne = () =>
    setMembers((ms) => [...ms, { id: uuid(), name: `人${ms.length + 1}` }]);

  const removeOne = (id: string) =>
    setMembers((ms) => (ms.length <= 1 ? ms : ms.filter((m) => m.id !== id)));

  const save = async () => {
    const cleaned = members.map((m) => ({ ...m, name: m.name.trim() }));
    if (cleaned.some((m) => !m.name)) { setError('成员姓名不能为空'); return; }
    const names = cleaned.map((m) => m.name);
    if (new Set(names).size !== names.length) { setError('成员姓名不能重复'); return; }

    setSaving(true);
    try {
      await db.updateTripMembers(trip.id, cleaned);
      onSaved(cleaned);
      onClose();
    } catch (e: any) {
      setError('保存失败: ' + (e?.message || '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 20, width: '100%', maxWidth: 420, maxHeight: '85vh', overflow: 'auto', color: '#eee' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <strong style={{ fontSize: 16, color: C.warning }}>同行成员</strong>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: '#6a6a80', marginBottom: 14, lineHeight: 1.5 }}>
          成员名单用于记账分摊与「按人查看」。改完记得保存。
        </div>

        {members.map((m, i) => (
          <div key={m.id} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6a6a80', width: 18, flexShrink: 0 }}>{i + 1}</span>
            <input
              value={m.name}
              onChange={(e) => { rename(m.id, e.target.value); setError(null); }}
              style={{ ...input, flex: 1 }}
              placeholder={`成员 ${i + 1}`}
            />
            <button
              onClick={() => removeOne(m.id)}
              disabled={members.length <= 1}
              title={members.length <= 1 ? '至少保留 1 人' : '移除该成员'}
              style={{
                background: 'rgba(255,107,107,0.14)', border: '1px solid rgba(255,107,107,0.25)',
                borderRadius: 6, color: C.danger, padding: '6px 10px', fontSize: 12, flexShrink: 0,
                cursor: members.length <= 1 ? 'not-allowed' : 'pointer',
                opacity: members.length <= 1 ? 0.4 : 1,
              }}
            >移除</button>
          </div>
        ))}

        <button onClick={addOne} style={{ ...btnGhost, ...btn, width: '100%', marginTop: 4 }}>+ 添加成员</button>

        <div style={{ marginTop: 12, fontSize: 13, color: '#9a9ab2' }}>
          当前 <strong style={{ color: '#e8e8f0' }}>{members.length}</strong> 人
          {members.length <= 1 && <span style={{ color: '#6a6a80' }}> · 单人出行时全部账目视为自付</span>}
        </div>
        <div style={{ marginTop: 4, fontSize: 11, color: '#6a6a80', lineHeight: 1.5 }}>
          ⚠️ 移除成员不会改动已有记账金额,但该成员参与过的分摊会退回给剩余成员。
        </div>

        {error && <p style={{ color: C.danger, fontSize: 13, marginTop: 10, marginBottom: 0 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button onClick={save} disabled={saving} style={{ ...btn(C.primary), flex: 1 }}>{saving ? '保存中…' : '保存'}</button>
          <button onClick={onClose} style={{ ...btnGhost, ...btn }}>取消</button>
        </div>
      </div>
    </div>
  );
}
