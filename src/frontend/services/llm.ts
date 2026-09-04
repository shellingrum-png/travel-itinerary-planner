/**
 * AI 景点卡片服务(5 层读取链, PRD §1.4)
 *
 * 1. RAG 攻略库(best-effort, 未配置/为空 → 静默跳过)
 * 2. AI 卡片缓存(poi_ai_cards, cache_key = md5(name+city))
 * 3. LLM 生成 → 写入缓存
 * 4. 类型兜底(景点90/餐厅60/购物45/未知90)
 * 5. 用户手动覆盖(UI 层锁定, 不被上述层覆盖)
 */
import { db } from './db';
import type { PoiAiCard, PoiCategory } from '../types';

const BASE_URL = import.meta.env.VITE_LLM_BASE_URL || 'https://api.deepseek.com/v1';
const API_KEY = import.meta.env.VITE_LLM_API_KEY || '';
const MODEL = import.meta.env.VITE_LLM_MODEL || 'deepseek-chat';

// 纯 JS md5 实现, 用于幂等缓存键
function md5(input: string): string {
  // 简化版 hash: 对个人项目够用, 后续可替换为 crypto.subtle.digest
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  const hash = ((h1 >>> 0) * 0x100000000 + (h2 >>> 0)).toString(16).padStart(16, '0');
  return hash;
}

export function buildPrompt(name: string, city: string): string {
  return [
    '你是旅行规划助手。为景点生成结构化卡片,只输出 JSON,不要多余文字:',
    '{',
    '  "recommend_reason": "推荐原因 2-3 句",',
    '  "pitfall_guide": "避坑指南 2-3 条,如预约/人流/体力",',
    '  "suggest_duration": 120,',
    '  "tips": ["...","..."],',
    '  "rating": 4.5',
    '}',
    `景点:${name},城市:${city}`,
    '信息求稳不求新,不确定的写"建议到店确认"。',
    '时长需考虑景点类型与淡旺季,输出整数分钟。',
  ].join('\n');
}

const TYPE_FALLBACK: Record<PoiCategory, number> = {
  poi: 90,
  restaurant: 60,
  shopping: 45,
  hotel: 90,
};

function typeFallbackDuration(category: PoiCategory): number {
  return TYPE_FALLBACK[category] ?? 90;
}

export async function getPoiCard(
  poi: { id: string; name: string; category?: PoiCategory },
  city: string,
): Promise<PoiAiCard> {
  const cacheKey = md5(`${poi.name}+${city}`);

  // ── 第 1 层: RAG 攻略库 (soft dependency) ──
  // Unconfigured / empty → silently skip
  try {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    if (supabaseUrl) {
      // RAG not yet implemented; skip for now
    }
  } catch { /* best-effort */ }

  // ── 第 2 层: AI 卡片缓存 ──
  const cached = await db.getPoiCardByKey(cacheKey);
  if (cached) return cached;

  // ── 第 3 层: LLM 生成 ──
  if (API_KEY && API_KEY !== 'your_llm_api_key') {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.3,
          messages: [{ role: 'user', content: buildPrompt(poi.name, city) }],
          response_format: { type: 'json_object' },
        }),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const data = await res.json();
      const content = JSON.parse(data.choices[0].message.content);
      const card: PoiAiCard = {
        poiId: poi.id,
        recommendReason: content.recommend_reason ?? '暂无推荐理由',
        pitfallGuide: content.pitfall_guide ?? '暂无避坑建议',
        suggestDuration: Number(content.suggest_duration) || typeFallbackDuration(poi.category ?? 'poi'),
        tips: Array.isArray(content.tips) ? content.tips : [],
        rating: Number(content.rating) || 4.0,
        cacheKey,
        llmModel: MODEL,
      };
      await db.upsertPoiCard(card);
      return card;
    } catch {
      // 失败 → 降级到第 4 层
    }
  }

  // ── 第 4 层: 类型兜底 ──
  const dur = typeFallbackDuration(poi.category ?? 'poi');
  const fallback: PoiAiCard = {
    poiId: poi.id,
    recommendReason: `${poi.name}为当地热门目的地,建议预留充足时间。`,
    pitfallGuide: '建议提前确认开放时间与预约要求;旺季人流密集。',
    suggestDuration: dur,
    tips: ['备好门票预约', '注意防晒补水'],
    rating: 4.0,
    cacheKey,
  };
  // 写入缓存, 下次直接命中
  await db.upsertPoiCard(fallback);
  return fallback;
}