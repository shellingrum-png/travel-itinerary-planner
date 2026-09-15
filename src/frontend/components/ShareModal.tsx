/**
 * 分享弹窗:为当前旅程生成只读链接,家人免登录查看。
 * 复制用 execCommand 兜底 —— 生产是 http://裸 IP,navigator.clipboard 是
 * SecureContext-only,在该环境下不可用(uuid 那批坑同源)。
 */
import { useEffect, useState } from 'react';
import { createShare, revokeShare, shareUrl } from '../services/share';
import { db } from '../services/db';
import { loadRoutePlanner } from '../services/amapLoader';
import { resolveAirports, buildSegments } from '../utils/shareSegments';
import { input, btn, btnGhost, btnDanger, C } from './ui';

/** 复制文本:优先 clipboard(安全上下文),否则 textarea+execCommand 兜底 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落到 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

interface Props {
  tripId: string;
  onClose: () => void;
}

export default function ShareModal({ tripId, onClose }: Props) {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'revoked'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setState('loading');
    setError(null);
    try {
      // 生成前:把本地尚缺的路线缓存补齐(否则家人端个别段会退回直线近似)
      try { await warmRouteCache(); } catch { /* 补齐失败不阻塞分享 */ }
      const token = await createShare(tripId);
      setUrl(shareUrl(token));
      setState('ready');
    } catch (e: any) {
      setError(e?.message || '生成分享链接失败');
      setState('error');
    }
  };

  /**
   * 预热路线缓存:拉一份当前快照(后端返回的公开端点即可),跑一遍路段计算,
   * 未命中的段会调高德并写入本地 route_cache(稍后随 share 一并下发)。
   */
  const warmRouteCache = async () => {
    // 先用已存在的分享 token 拉快照(避免重复生成);没有就直接读本地旅程
    let snap = null as any;
    // 本地旅程 + 大交通足以构建点序列
    const trip = await db.getTrip(tripId);
    if (!trip) return;
    const days = await db.listDays(tripId);
    const items = (await Promise.all(days.map((d) => db.listItems(d.id)))).flat();
    const poiIds = [...new Set(items.map((i) => i.poiId).filter(Boolean))] as string[];
    const pois = (await Promise.all(poiIds.map((id) => db.getPoi(id)))).filter(Boolean);
    const transports = await db.listTransports(tripId);
    const hotels = await db.listHotels(tripId);
    const expenses = await db.listExpenses(tripId);
    snap = { trip, days, items, pois, aiCards: [], hotels, transports, expenses, savedAt: new Date().toISOString() };
    await Promise.all([loadRoutePlanner('drive'), loadRoutePlanner('walk'), loadRoutePlanner('transit')]).catch(() => {});
    const ap = await resolveAirports(snap);
    await buildSegments(snap, ap, 2);
  };

  useEffect(() => { generate(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tripId]);

  const handleCopy = async () => {
    const ok = await copyText(url);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setError('复制失败,请手动选中链接复制');
    }
  };

  const handleRevoke = async () => {
    if (!window.confirm('撤销后原链接立即失效,已分享给家人的链接将无法打开。确定撤销?')) return;
    setBusy(true);
    setError(null);
    try {
      await revokeShare(tripId);
      setState('revoked');
      setUrl('');
    } catch (e: any) {
      setError(e?.message || '撤销失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 20, width: '100%', maxWidth: 440, color: '#eee' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <strong style={{ fontSize: 16, color: C.warning }}>分享给家人</strong>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: '#6a6a80', marginBottom: 14, lineHeight: 1.5 }}>
          家人无需注册登录,点开链接即可查看这份行程(只读,不能修改)。
        </div>

        {state === 'loading' && (
          <p style={{ color: '#9a9ab0', fontSize: 13 }}>正在准备链接(计算路线里程,首次约需十几秒)…</p>
        )}

        {state === 'error' && (
          <div>
            <p style={{ color: C.danger, fontSize: 13, margin: 0 }}>{error}</p>
            <button onClick={generate} style={{ ...btnGhost, ...btn, marginTop: 12 }}>重试</button>
          </div>
        )}

        {state === 'revoked' && (
          <div>
            <p style={{ color: C.success, fontSize: 13, margin: 0 }}>已撤销分享,原链接已失效。</p>
            <button onClick={generate} style={{ ...btnGhost, ...btn, marginTop: 12 }}>重新生成链接</button>
          </div>
        )}

        {state === 'ready' && (
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input value={url} readOnly style={{ ...input, flex: 1 }} onFocus={(e) => e.target.select()} />
              <button onClick={handleCopy} style={{ ...btn(C.primary), flexShrink: 0, minWidth: 76 }}>
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            {error && <p style={{ color: C.danger, fontSize: 12, margin: '0 0 10px' }}>{error}</p>}
            <button onClick={handleRevoke} disabled={busy} style={{ ...btnDanger, ...btn, width: '100%' }}>
              {busy ? '撤销中…' : '撤销分享'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
