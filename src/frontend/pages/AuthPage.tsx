import { useState } from 'react';
import { signIn, signUp } from '../services/auth';
import { btn, btnGhost, input } from '../components/ui';

export default function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async () => {
    if (!email || !password) { setError('请输入邮箱和密码'); return; }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'login') {
        await signIn(email, password);
        // 登录成功由 App.tsx 的 onAuthStateChange 处理清库+重拉
      } else {
        const { hasSession } = await signUp(email, password);
        if (hasSession) {
          // 注册即登录,交给 App 的 onAuthStateChange 处理
          setNotice('注册成功,正在进入…');
        } else {
          // 未拿到 session(如服务端要求邮箱确认)
          setNotice('注册成功,请到邮箱确认后再登录');
          setMode('login');
        }
      }
    } catch (e: any) {
      setError(e?.message || '操作失败,请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 380, margin: '0 auto', padding: '60px 24px', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, textAlign: 'center' }}>旅行行程规划</h1>
      <p style={{ color: '#9a9ab0', textAlign: 'center', fontSize: 13, marginBottom: 24 }}>
        {mode === 'login' ? '登录后查看你的旅程' : '注册一个新账号'}
      </p>

      {error && <div style={{ background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.4)', color: '#ff6b6b', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {notice && <div style={{ background: 'rgba(6,214,160,0.1)', border: '1px solid rgba(6,214,160,0.4)', color: '#06d6a0', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>{notice}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input type="email" placeholder="邮箱" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} style={{ ...input, flex: 1 }} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input type="password" placeholder="密码(至少6位)" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} style={{ ...input, flex: 1 }} />
      </div>

      <button onClick={submit} disabled={loading} style={{ ...btn(), width: '100%', marginBottom: 12 }}>
        {loading ? '处理中…' : mode === 'login' ? '登录' : '注册'}
      </button>

      <button
        onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); setNotice(null); }}
        style={{ ...btnGhost, width: '100%' }}
      >
        {mode === 'login' ? '没有账号?去注册' : '已有账号?去登录'}
      </button>
    </div>
  );
}
