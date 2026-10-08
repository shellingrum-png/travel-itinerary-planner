/**
 * 导航:全局共用的「选哪个地图」菜单 + 触发按钮。
 *
 * 用法:App 顶层包一次 <NavProvider>,任何页面放 <NavButton to={...} from={...} /> 即可。
 * 点按钮 → 底部弹出高德/百度/腾讯三个选项 → 点了跳对应地图。
 * 传了 from 就是「上一站 → 本站」的路线,不传则各家默认从当前定位出发。
 *
 * 为什么不让系统自动挑:手机上装了哪个地图 App 因人而异,单发一个高德链接
 * 在只装百度地图的手机上唤不起来。由用户自己选最稳。
 * 链接格式与经纬度顺序见 utils/navUrl.ts。
 */
import { createContext, useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { NAV_APPS, launchMap, type NavTarget } from '../utils/navUrl';

interface NavReq { to: NavTarget; from?: NavTarget }

const NavCtx = createContext<(req: NavReq) => void>(() => {});

export function NavProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<NavReq | null>(null);
  return (
    <NavCtx.Provider value={setReq}>
      {children}
      {req && <NavMenuSheet to={req.to} from={req.from} onClose={() => setReq(null)} />}
    </NavCtx.Provider>
  );
}

/** 打开导航菜单 */
export function useNav() {
  return useContext(NavCtx);
}

/**
 * 导航按钮。各页面直接用,不必各自管理弹层。
 * to 无有效坐标时不渲染(避免点了没反应);from 可选(有则是「从上一站出发」)。
 */
export function NavButton({ to, from, label = '导航', style }: {
  to?: NavTarget | null;
  from?: NavTarget | null;
  label?: string;
  style?: CSSProperties;
}) {
  const open = useNav();
  if (!to || to.lng === 0 || to.lat === 0) return null;
  const hasFrom = !!from && from.lng !== 0 && from.lat !== 0;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); open({ to, from: hasFrom ? from! : undefined }); }}
      title={hasFrom ? `从「${from!.name}」导航到「${to.name}」` : `导航到 ${to.name}`}
      style={{
        flexShrink: 0, fontSize: 12, color: '#1677ff', background: 'none', cursor: 'pointer',
        border: '1px solid #1677ff', borderRadius: 6, padding: '1px 8px',
        ...style,
      }}
    >
      {label}
    </button>
  );
}

function NavMenuSheet({ to, from, onClose }: NavReq & { onClose: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '16px 16px 0 0', padding: '16px 16px 22px', width: '100%', maxWidth: 480, color: '#eee' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <strong style={{ fontSize: 15 }}>导航到</strong>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        {from ? (
          <div style={{ fontSize: 12, color: '#7eb8e0', marginBottom: 12 }}>
            从「{from.name}」出发 →
          </div>
        ) : null}
        <div style={{ fontSize: 13, color: '#9a9ab2', marginBottom: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {to.name}
        </div>
        {NAV_APPS.map((app) => (
          <button
            key={app.key}
            // 唤起 App 时带起点;若唤不起(没装 App / 微信等内置浏览器禁止 scheme),
            // 兜底跳「无起点」的网页版 —— 至少能自动导航,不会像带起点的百度网页版那样跳首页。
            onClick={() => { launchMap(app.scheme(to, from), app.web(to)); onClose(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', width: '100%', cursor: 'pointer',
              padding: '13px 14px', marginBottom: 8, borderRadius: 10,
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
              color: '#e9e9f2', fontSize: 14,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: app.color, flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{app.label}</span>
            <span style={{ color: '#6a6a80', fontSize: 16 }}>›</span>
          </button>
        ))}
        <div style={{ fontSize: 11, color: '#5a5a70', marginTop: 6, lineHeight: 1.5 }}>
          {from ? '' : '未指定起点,将按各 App 的当前定位出发。'}
          装了对应地图 App 会直接打开 App 并开始导航(含起点);没装或在内置浏览器里,则转为网页版地图。
        </div>
      </div>
    </div>
  );
}
