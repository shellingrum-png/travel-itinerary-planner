import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';

// 全局错误捕获 → 控制台(供诊断)
window.addEventListener('error', (e) => {
  console.error('[全局错误]', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[未处理Promise]', e.reason);
});

// ErrorBoundary:React 渲染错误全屏显示,便于定位崩溃
class RootBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ position: 'fixed', inset: 0, background: '#260000', color: '#ff9999', zIndex: 9999, padding: 30, overflow: 'auto', fontFamily: 'monospace', fontSize: 13 }}>
          <h3>🚨 React 渲染错误</h3>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.stack || String(this.state.error)}</pre>
          <button onClick={() => { this.setState({ error: null }); window.location.reload(); }} style={{ padding: '8px 16px', marginTop: 12, cursor: 'pointer' }}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <RootBoundary>
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  </RootBoundary>,
);