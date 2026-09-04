// 一键顺路优化(TSP 求解)
// n ≤ 8:Held-Karp 精确解;n > 8:2-opt 局部搜索近似解
// 自动为当天景点 + 酒店计算最短闭环,返回最佳访问顺序与可节省分钟数

export interface TspInput {
  count: number; // 总点数(含酒店,酒店索引恒为 0)
  duration: (i: number, j: number) => number; // 通勤分钟矩阵取值,0 表示同点
}

export interface TspResult {
  order: number[]; // 最优访问顺序(相对索引 0..n-1,不含酒店)
  totalDuration: number; // 闭环总通勤分钟
  savedMinutes: number | null; // 相对当前顺序的节省分钟;不可比时为 null
  exact: boolean; // true = Held-Karp 精确解
}

const n = (count: number) => count - 1; // 景点数

/**
 * 以酒店(索引 0)为起点与终点,求经过全部景点的最短闭环。
 * 返回相对索引 [0..n-1] 的访问顺序。
 */
export function solveTsp(input: TspInput): TspResult {
  const { count, duration } = input;
  const m = n(count);
  if (m <= 0) return { order: [], totalDuration: 0, savedMinutes: 0, exact: true };
  if (m === 1) {
    const d = duration(0, 1) + duration(1, 0); // 直接索引对照
    return { order: [0], totalDuration: d, savedMinutes: 0, exact: true };
  }
  return m <= 8 ? heldKarp(count, duration) : twoOpt(count, duration);
}

/**
 * Held-Karp DP:O(m²·2^m),只在景点数 ≤ 8 时使用。
 * dp[mask][v] = 访问集合 mask(低位可标识各景点)且最后在 v 的最小代价。
 * 用 parent 记录前驱和前驱 mask 以便回溯路径。
 */
function heldKarp(count: number, duration: (i: number, j: number) => number): TspResult {
  const m = n(count);
  const SIZE = 1 << m;
  const INF = Number.POSITIVE_INFINITY;

  const dp = new Float64Array(SIZE * m).fill(INF);
  const parentMask = new Int32Array(SIZE * m).fill(-1);
  const parentOf = new Int32Array(SIZE * m).fill(-1);
  // 景点实际物理索引 i+1(0 是酒店)

  // 单点:从酒店直达景点 v
  for (let v = 0; v < m; v++) dp[(1 << v) * m + v] = duration(0, v + 1);

  for (let mask = 1; mask < SIZE; mask++) {
    for (let v = 0; v < m; v++) {
      if (!(mask & (1 << v))) continue;
      const cur = dp[mask * m + v];
      if (cur === INF) continue;
      for (let w = 0; w < m; w++) {
        if (mask & (1 << w)) continue;
        const nm = mask | (1 << w);
        const nc = cur + duration(v + 1, w + 1);
        if (nc < dp[nm * m + w]) {
          dp[nm * m + w] = nc;
          parentMask[nm * m + w] = mask;
          parentOf[nm * m + w] = v;
        }
      }
    }
  }

  // 闭环:最后回到酒店
  const full = SIZE - 1;
  let bestCost = INF;
  let bestLast = -1;
  for (let v = 0; v < m; v++) {
    const c = dp[full * m + v] + duration(v + 1, 0);
    if (c < bestCost) {
      bestCost = c;
      bestLast = v;
    }
  }
  if (bestLast === -1) return { order: [], totalDuration: 0, savedMinutes: 0, exact: true };

  // 回溯
  const orderRev: number[] = [];
  let mask = full;
  let v = bestLast;
  while (v !== -1) {
    orderRev.push(v);
    const pm = parentMask[mask * m + v];
    const pv = parentOf[mask * m + v];
    mask = pm;
    v = pv;
  }
  const order = orderRev.reverse();
  return { order, totalDuration: bestCost, savedMinutes: 0, exact: true };
}

/** 2-opt 局部搜索近似:景点数 > 8 时使用 */
function twoOpt(count: number, duration: (i: number, j: number) => number): TspResult {
  const m = n(count);
  const seq: number[] = Array.from({ length: m }, (_, i) => i); // 相对索引序列
  const dist = (a: number, b: number) => duration(a + 1, b + 1);
  const rootDist = (a: number) => duration(0, a + 1);

  const total = (path: number[]): number => {
    let s = rootDist(path[0]);
    for (let k = 0; k < path.length - 1; k++) s += dist(path[k], path[k + 1]);
    return s + rootDist(path[path.length - 1]);
  };

  let best = total(seq);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 1000) {
    improved = false;
    for (let i = 0; i < m - 1; i++) {
      for (let j = i + 1; j < m; j++) {
        const nh = seq.slice();
        let lo = i;
        let hi = j;
        while (lo < hi) {
          [nh[lo], nh[hi]] = [nh[hi], nh[lo]];
          lo++;
          hi--;
        }
        const c = total(nh);
        if (c < best) {
          best = c;
          seq.splice(0, seq.length, ...nh);
          improved = true;
        }
      }
    }
  }

  return { order: seq, totalDuration: best, savedMinutes: null, exact: false };
}

/** 对比「当前顺序」与「最优顺序」,返回节省的分钟数(仅供提示,非负) */
export function savings(
  currentOrder: number[],
  optimalOrder: number[],
  duration: (i: number, j: number) => number,
): number {
  const root = 0;
  const loop = (order: number[]): number => {
    if (!order.length) return 0;
    let s = duration(root, order[0] + 1);
    for (let k = 0; k < order.length - 1; k++) s += duration(order[k] + 1, order[k + 1] + 1);
    return s + duration(order[order.length - 1] + 1, root);
  };
  return Math.max(0, loop(currentOrder) - loop(optimalOrder));
}

/**
 * 开放路径 TSP(全局顺路):从固定起点(索引 0)出发,经过全部点后结束,不返回起点。
 * 用于跨天防折返——保证 Day1→Day2→…→DayN 沿一条线推进,不回头。
 * n ≤ 9 Held-Karp 精确;n > 9 2-opt 近似。
 */
export function solveOpenPath(input: { count: number; duration: (i: number, j: number) => number }): {
  order: number[]; // 相对索引[0..n-2],索引 0 是固定起点不参与排列
  totalDuration: number;
} {
  const { count, duration } = input;
  const m = count - 1; // 需要排序的点数(不含起点)
  if (m <= 0) return { order: [], totalDuration: 0 };
  if (m === 1) return { order: [0], totalDuration: duration(0, 1) };
  return m <= 9 ? heldKarpOpen(count, duration) : twoOptOpen(count, duration);
}

/** 开放路径 Held-Karp:终点任意,不回首起点 */
function heldKarpOpen(count: number, duration: (i: number, j: number) => number): {
  order: number[]; totalDuration: number;
} {
  const m = count - 1;
  const SIZE = 1 << m;
  const INF = Number.POSITIVE_INFINITY;
  const dp = new Float64Array(SIZE * m).fill(INF);
  const parentMask = new Int32Array(SIZE * m).fill(-1);
  const parentOf = new Int32Array(SIZE * m).fill(-1);

  for (let v = 0; v < m; v++) dp[(1 << v) * m + v] = duration(0, v + 1);
  for (let mask = 1; mask < SIZE; mask++) {
    for (let v = 0; v < m; v++) {
      if (!(mask & (1 << v))) continue;
      const cur = dp[mask * m + v];
      if (cur === INF) continue;
      for (let w = 0; w < m; w++) {
        if (mask & (1 << w)) continue;
        const nm = mask | (1 << w);
        const nc = cur + duration(v + 1, w + 1);
        if (nc < dp[nm * m + w]) {
          dp[nm * m + w] = nc;
          parentMask[nm * m + w] = mask;
          parentOf[nm * m + w] = v;
        }
      }
    }
  }

  const full = SIZE - 1;
  let bestCost = INF;
  let bestLast = -1;
  for (let v = 0; v < m; v++) {
    if (dp[full * m + v] < bestCost) { bestCost = dp[full * m + v]; bestLast = v; }
  }
  if (bestLast === -1) return { order: [], totalDuration: 0 };

  const orderRev: number[] = [];
  let mask = full;
  let v = bestLast;
  while (v !== -1) {
    orderRev.push(v);
    const pm = parentMask[mask * m + v];
    const pv = parentOf[mask * m + v];
    mask = pm;
    v = pv;
  }
  return { order: orderRev.reverse(), totalDuration: bestCost };
}

/** 开放路径 2-opt */
function twoOptOpen(count: number, duration: (i: number, j: number) => number): {
  order: number[]; totalDuration: number;
} {
  const m = count - 1;
  const seq: number[] = Array.from({ length: m }, (_, i) => i);
  const dist = (a: number, b: number) => duration(a + 1, b + 1);
  const rootDist = (a: number) => duration(0, a + 1);
  const total = (path: number[]): number => {
    let s = rootDist(path[0]);
    for (let k = 0; k < path.length - 1; k++) s += dist(path[k], path[k + 1]);
    return s; // 不回首
  };
  let best = total(seq);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 1000) {
    improved = false;
    for (let i = 0; i < m - 1; i++) {
      for (let j = i + 1; j < m; j++) {
        const nh = seq.slice();
        let lo = i, hi = j;
        while (lo < hi) { [nh[lo], nh[hi]] = [nh[hi], nh[lo]]; lo++; hi--; }
        const c = total(nh);
        if (c < best) { best = c; seq.splice(0, seq.length, ...nh); improved = true; }
      }
    }
  }
  return { order: seq, totalDuration: best };
}

/** 根据已知坐标算两点直线距离(km, haversine) */
export function haversineKm(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}