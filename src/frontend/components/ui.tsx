/**
 * 公共 UI 样式/组件(v0.8 设计 token)
 * 统一暗色现代风,抽公共样式减少内联重复。
 * 改动主题只改这里 + theme.css,全站生效。
 */
import type { CSSProperties, ReactNode } from 'react';

// ── 颜色 token(与 theme.css 保持一致) ──
export const C = {
  primary: '#1677ff',
  success: '#06d6a0',
  warning: '#ffd166',
  danger: '#ff6b6b',
  info: '#7eb8e0',
  accent: '#b8a0e0',
};

// ── 面板/卡片 ──
export const card: CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: 12,
  padding: 16,
};

export const panel: CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  padding: 12,
  marginTop: 10,
};

// ── 输入框(与 theme.css 全局基线一致) ──
export const input: CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.16)',
  borderRadius: 6,
  padding: '7px 10px',
  color: '#e9e9f2',
  fontSize: 13,
  width: '100%',
  outline: 'none',
};
export const inputFocus = { border: '1px solid rgba(22,119,255,0.6)' };

// ── 按钮 ──
export const btn = (bg = C.primary, textColor = '#fff'): CSSProperties => ({
  background: bg,
  color: textColor,
  border: 'none',
  borderRadius: 8,
  padding: '8px 16px',
  fontSize: 13,
  cursor: 'pointer',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  transition: 'opacity 0.15s, transform 0.05s',
});
export const btnGhost: CSSProperties = { background: 'rgba(255,255,255,0.08)', color: '#e9e9f2', border: '1px solid rgba(255,255,255,0.12)' };
export const btnSmall = { fontSize: 12, padding: '5px 11px' };
export const btnDanger: CSSProperties = { background: 'rgba(255,107,107,0.14)', color: '#ff6b6b', border: '1px solid rgba(255,107,107,0.25)' };

// ── 标签/徽章 ──
export const badge = (bg: string): CSSProperties => ({
  background: bg + '22',
  color: bg,
  border: `1px solid ${bg}44`,
  borderRadius: 6,
  padding: '1px 8px',
  fontSize: 11,
  whiteSpace: 'nowrap',
});

// ── Tab 按钮 ──
export const tabBtn = (active: boolean): CSSProperties => ({
  flex: 1,
  padding: '8px 0',
  fontSize: 13,
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  background: active ? C.primary : 'rgba(255,255,255,0.07)',
  color: active ? '#fff' : '#9a9ab2',
  fontWeight: active ? 600 : 400,
});

// ── 强调色条 ──
export const colorBar = (color: string): CSSProperties => ({
  borderLeft: `3px solid ${color}`,
});

// ── 数字徽标(地图/编号用) ──
export const cityColor = (i: number): string =>
  ['#ff6b6b', '#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#f77f00', '#8338ec', '#3a86ff', '#ff006e', '#06d6a0'][i % 10];

// ── 小组件:色点 + 标签 ──
export function ColorDot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0 }} />
  );
}

// ── 页面容器(居中 max-width) ──
export function Page({ children, maxWidth = 600 }: { children: ReactNode; maxWidth?: number }) {
  return (
    <div style={{ maxWidth, margin: '0 auto', padding: 24, minHeight: '100vh' }}>{children}</div>
  );
}

// ── 页面标题块(统一字号/间距/副标题) ──
export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: 0.2 }}>{title}</h1>
        {subtitle && <p style={{ color: '#9a9ab2', fontSize: 13, margin: '6px 0 0' }}>{subtitle}</p>}
      </div>
      {right && <div style={{ flexShrink: 0 }}>{right}</div>}
    </div>
  );
}

// ── 返回链接 ──
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return <a href={to} style={{ color: C.success, fontSize: 13, textDecoration: 'none' }}>← {children}</a>;
}

// ── 空状态 ──
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ textAlign: 'center', color: '#6a6a80', fontSize: 13, padding: '40px 16px', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: 12 }}>
      {children}
    </div>
  );
}

// ── 提示条 ──
export function Callout({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'success' | 'warning' | 'danger' }) {
  const color = tone === 'success' ? C.success : tone === 'warning' ? C.warning : tone === 'danger' ? C.danger : C.info;
  return (
    <div style={{ background: color + '12', border: `1px solid ${color}30`, borderRadius: 8, padding: '8px 12px', fontSize: 13, color, margin: '8px 0' }}>
      {children}
    </div>
  );
}
