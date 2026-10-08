#!/usr/bin/env node
/**
 * 把服务器本地文件快照(server/data/trips/<userId>/<tripId>.json)同步进 Supabase
 * trips 表,作为异地备份。
 *
 * 设计要点:
 *  - 一趟一 upsert,以 id 为主键(resolution=merge-duplicates)。
 *  - 幂等:同 id 覆盖。snapshot / updated_at 都取自文件里已有的值,不做本地改写。
 *  - 默认 --dry-run 只看不写;要真正写入须显式传 --apply。
 *  - 读服务端 server/.env 的 SUPABASE_URL / SUPABASE_KEY(service_role)。
 *
 * 用法:
 *   node sync_to_supabase.mjs --dry-run
 *   node sync_to_supabase.mjs --apply
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, '..', 'server');
const DATA_DIR = join(SERVER_DIR, 'data', 'trips');

const APPLY = process.argv.includes('--apply');

// ── 读 server/.env(只需 SUPABASE_URL / SUPABASE_KEY) ──
function loadEnv() {
  const env = {};
  try {
    const content = fs.readFileSync(join(SERVER_DIR, '.env'), 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim();
    }
  } catch {
    /* 无 .env 则退回 process.env */
  }
  return { ...env, ...process.env };
}
const ENV = loadEnv();
const URL = ENV.SUPABASE_URL;
const KEY = ENV.SUPABASE_KEY;
if (!URL || !KEY) {
  console.error('❌ 缺少 SUPABASE_URL / SUPABASE_KEY(见 server/.env)');
  process.exit(1);
}

/** 收集所有待同步行 */
function collectRows() {
  const rows = [];
  let uids = [];
  try {
    uids = fs.readdirSync(DATA_DIR).filter((n) => {
      try { return fs.statSync(join(DATA_DIR, n)).isDirectory(); } catch { return false; }
    });
  } catch {
    return rows;
  }
  for (const uid of uids) {
    const dir = join(DATA_DIR, uid);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const fp = join(dir, f);
      try {
        const o = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const trip = o.snapshot?.trip || {};
        rows.push({
          id: o.id || f.replace(/\.json$/, ''),
          user_id: o.user_id || uid,
          title: o.title || trip.title || '',
          snapshot: o.snapshot || null,
          share_token: o.share_token || null,
          share_route_cache: o.share_route_cache || [],
          updated_at: o.updated_at || o.snapshot?.savedAt || new Date().toISOString(),
          _file: fp,
        });
      } catch (e) {
        console.warn(`  ⚠️ 跳过无法解析的文件 ${fp}: ${e.message}`);
      }
    }
  }
  return rows;
}

async function main() {
  console.log(`[sync] 数据目录: ${DATA_DIR}`);
  const rows = collectRows();
  console.log(`[sync] 发现 ${rows.length} 条快照`);
  for (const r of rows) {
    const s = r.snapshot || {};
    console.log(`  - ${r.id.slice(0, 8)} user=${String(r.user_id).slice(0, 12)} ` +
      `title="${r.title}" days=${(s.days || []).length} items=${(s.items || []).length} ` +
      `exp=${(s.expenses || []).length} updated=${r.updated_at}`);
  }
  if (!rows.length) { console.log('[sync] 无数据,退出'); return; }
  if (!APPLY) { console.log('[sync] DRY-RUN,未写入。加 --apply 才真正写库'); return; }

  let ok = 0, fail = 0;
  for (const r of rows) {
    const body = { ...r };
    delete body._file;
    try {
      const res = await fetch(`${URL}/rest/v1/trips`, {
        method: 'POST',
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text();
        console.error(`  ❌ ${r.id.slice(0, 8)} HTTP ${res.status}: ${t.slice(0, 200)}`);
        fail++;
      } else {
        console.log(`  ✅ ${r.id.slice(0, 8)} 已写入`);
        ok++;
      }
    } catch (e) {
      console.error(`  ❌ ${r.id.slice(0, 8)} ${e.message}`);
      fail++;
    }
  }
  console.log(`[sync] 完成:成功 ${ok},失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main();
