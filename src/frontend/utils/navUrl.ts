/**
 * 导航链接生成(高德 / 百度 / 腾讯)。
 *
 * ⚠️ 三家的经纬度顺序**各不相同**,写反了会导到地球另一头:
 *   高德  → lng,lat
 *   百度  → lat,lng
 *   腾讯  → lat,lng
 * 坐标是 Poi.lng/lat(gcj02 高德系),三家都按 gcj02 传,无需转换。
 *
 * 为什么每家给两套链接(scheme + web):
 *   - scheme(App 专属,如 amapuri://)能「带起点 + 直接唤起 App 开始导航」,
 *     这正是我们要的;但手机没装对应 App 时点了没反应。
 *   - web(https 网页版)一定能打开,但**一旦带起点,高德就变成路线预览页
 *     (需手动点一下才进导航)、百度直接跳首页** —— 所以不能拿它当主链接。
 *   做法:主用 scheme,2 秒内没成功唤起(页面仍可见)就自动兜底跳 web。
 *   见 NavMenu.launchMap。
 */
export interface NavTarget {
  name: string;
  lng: number;
  lat: number;
}

export type NavAppKey = 'amap' | 'baidu' | 'tencent';

/** 高德:lng,lat,name(经度在前) */
function amapCoord(p: NavTarget): string {
  return `${p.lng},${p.lat},${encodeURIComponent(p.name)}`;
}

/** 高德 App 唤起链接(t=0 驾车,dev=0 表示坐标已是 gcj02 无需再加密) */
export function amapScheme(to: NavTarget, from?: NavTarget): string {
  const qs: string[] = ['sourceApplication=travel-share'];
  if (from) qs.push(`slat=${from.lat}`, `slon=${from.lng}`, `sname=${encodeURIComponent(from.name)}`);
  qs.push(`dlat=${to.lat}`, `dlon=${to.lng}`, `dname=${encodeURIComponent(to.name)}`, 'dev=0', 't=0');
  return `amapuri://route/plan/?${qs.join('&')}`;
}
/** 高德网页版(兜底) */
export function amapWeb(to: NavTarget, from?: NavTarget): string {
  const fromQs = from ? `from=${amapCoord(from)}&` : '';
  return `https://uri.amap.com/navigation?${fromQs}to=${amapCoord(to)}&mode=car&coordinate=gaode&src=travel-share`;
}

/** 百度 App 唤起链接(nd/dlat 用 lat,lng;coord_type 声明 gcj02) */
export function baiduScheme(to: NavTarget, from?: NavTarget): string {
  const fromQs = from ? `origin=${from.lat},${from.lng}&` : '';
  return `baidumap://map/direction?${fromQs}destination=${to.lat},${to.lng}&mode=driving&coord_type=gcj02&src=travel-share`;
}
/** 百度网页版(兜底) */
export function baiduWeb(to: NavTarget, from?: NavTarget): string {
  const fromQs = from ? `origin=${from.lat},${from.lng}&` : '';
  return `https://api.map.baidu.com/direction?${fromQs}destination=${to.lat},${to.lng}&mode=driving&coord_type=gcj02&output=html&src=travel-share`;
}

/** 腾讯 App 唤起链接 */
export function tencentScheme(to: NavTarget, from?: NavTarget): string {
  const fromQs = from ? `from=${encodeURIComponent(from.name)}&fromcoord=${from.lat},${from.lng}&` : '';
  return `qqmap://map/routeplan?type=drive&${fromQs}to=${encodeURIComponent(to.name)}&tocoord=${to.lat},${to.lng}&referer=travel-share`;
}
/** 腾讯网页版(兜底) */
export function tencentWeb(to: NavTarget, from?: NavTarget): string {
  const fromQs = from ? `from=${encodeURIComponent(from.name)}&fromcoord=${from.lat},${from.lng}&` : '';
  return `https://apis.map.qq.com/uri/v1/routeplan?type=drive&${fromQs}to=${encodeURIComponent(to.name)}&tocoord=${to.lat},${to.lng}&referer=travel-share`;
}

export const NAV_APPS: {
  key: NavAppKey; label: string; color: string;
  scheme: (to: NavTarget, from?: NavTarget) => string;
  web: (to: NavTarget, from?: NavTarget) => string;
}[] = [
  { key: 'amap', label: '高德地图', color: '#1677ff', scheme: amapScheme, web: amapWeb },
  { key: 'baidu', label: '百度地图', color: '#2b6de5', scheme: baiduScheme, web: baiduWeb },
  { key: 'tencent', label: '腾讯地图', color: '#12b7f5', scheme: tencentScheme, web: tencentWeb },
];

/** 从有序点序列里找 `id` 的前一个点(用于「从上一站出发」);第一个点返回 undefined */
export function findPrevPoint<T extends { id: string }>(ordered: T[], id: string): T | undefined {
  const i = ordered.findIndex((p) => p.id === id);
  return i > 0 ? ordered[i - 1] : undefined;
}

/**
 * 唤起地图 App;若 2 秒内没成功(页面仍处于可见状态),自动兜底跳网页版。
 * 必须在用户点击手势里同步调用(scheme 跳转依赖用户手势)。
 */
export function launchMap(scheme: string, web: string): void {
  let leftPage = false;
  const onVis = () => { if (document.visibilityState === 'hidden') leftPage = true; };
  document.addEventListener('visibilitychange', onVis);
  const cleanup = () => document.removeEventListener('visibilitychange', onVis);
  const timer = setTimeout(() => {
    cleanup();
    if (!leftPage && document.visibilityState === 'visible') window.location.href = web;
  }, 2000);
  try {
    window.location.href = scheme;
  } catch {
    clearTimeout(timer);
    cleanup();
    window.location.href = web;
  }
}
