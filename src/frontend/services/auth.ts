/**
 * 认证模块(V10 多用户)
 * 用 Supabase Auth(邮箱+密码)登录,导出 session/token 给 sync.ts 与路由守卫。
 * anon key(public)可安全打进前端 bundle;service_role 只在服务端。
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export function isAuthConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || null;
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data.session?.user ?? null;
}

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  // 若未开启邮箱确认,session 可能直接存在;开启则需用户点确认邮件
  return data.session?.user ?? data.user ?? null;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export function onAuthStateChange(cb: (user: { id: string; email?: string } | null) => void) {
  const { data } = supabase.auth.onAuthStateChange((_e, session) => {
    cb(session?.user ? { id: session.user.id, email: session.user.email } : null);
  });
  return data.subscription;
}

export async function getCurrentUser(): Promise<{ id: string; email?: string } | null> {
  const { data } = await supabase.auth.getUser();
  return data.user ? { id: data.user.id, email: data.user.email } : null;
}
