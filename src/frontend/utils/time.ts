// 时间工具:全 app 唯一时间计算入口,需单测
// 约定:HH:MM 24 小时制;跨午夜用 24h+ 记号(25:30)

export type TimeStr = string; // "HH:MM" or "25:30"

/** "09:30" -> 分钟数 570 */
export function toMinutes(t: TimeStr): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** 分钟数 -> "HH:MM"(自动处理 >= 24 的小时) */
export function toTimeStr(min: number): TimeStr {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** t + mins,返回新的 HH:MM */
export function addMinutes(t: TimeStr, mins: number): TimeStr {
  return toTimeStr(toMinutes(t) + mins);
}

/** V6.0 时间段映射(预览模式):隐藏具体分钟,改为上午/中午/下午/晚上 */
export function timePeriod(time: TimeStr): '上午' | '中午' | '下午' | '晚上' {
  const h = toMinutes(time) / 60;
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  return '晚上';
}

export interface CascadeNode {
  visitMinutes: number; // 本节点停留(poi 用游玩时长,buffer 用 0)
  nextDurationMin: number; // 到下一节点的通勤
}

export interface CascadeResult {
  arrive: TimeStr;
  leave: TimeStr;
}

/**
 * 时间级联(§3.2 公式):
 *   下一景点到达时间 = 上一景点离开时间 + 路程通勤时间
 */
export function cascadeTimes(
  start: TimeStr,
  nodes: CascadeNode[],
): CascadeResult[] {
  let t = start;
  return nodes.map((n) => {
    const arrive = t;
    const leave = addMinutes(arrive, n.visitMinutes);
    t = addMinutes(leave, n.nextDurationMin); // 交给下一节点
    return { arrive, leave };
  });
}