/**
 * 高德 JS API 2.0 加载器
 * 安全密钥 + JS Key,加载后全局可用 window.AMap
 */

const AMAP_JS_KEY = import.meta.env.VITE_AMAP_JS_KEY || '9a5f6f729b7e6e7577d18d31a5d52e97';
const AMAP_JS_SECRET = import.meta.env.VITE_AMAP_JS_SECRET || '8f94a2936a7e6b5f8d294324819dbc46';

let loadPromise: Promise<typeof window.AMap> | null = null;

export function loadAMap(): Promise<typeof window.AMap> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    // 安全密钥必须在 JS API 加载前设置
    (window as any)._AMapSecurityConfig = { securityJsCode: AMAP_JS_SECRET };

    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${AMAP_JS_KEY}&callback=amapLoaded`;
    script.async = true;
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('高德地图加载失败'));
    };

    (window as any).amapLoaded = () => {
      resolve(window.AMap);
    };

    document.head.appendChild(script);
  });

  return loadPromise;
}

/** 加载高德 PlaceSearch 插件（JS API 内置搜索，无需 Web 服务 Key） */
export function loadPlaceSearch(): Promise<any> {
  return new Promise((resolve, reject) => {
    loadAMap().then((AMap) => {
      AMap.plugin('AMap.PlaceSearch', () => {
        resolve(AMap.PlaceSearch);
      });
    }).catch(reject);
  });
}

/** 加载路线规划插件(按方式):Car=驾车 Walk=步行 Transfer=公交 */
export function loadRoutePlanner(mode: 'drive' | 'walk' | 'transit'): Promise<any> {
  const plugin = mode === 'drive' ? 'AMap.Driving' : mode === 'walk' ? 'AMap.Walking' : 'AMap.Transfer';
  return new Promise((resolve, reject) => {
    loadAMap().then((AMap) => {
      AMap.plugin(plugin, () => {
        const Cls = mode === 'drive' ? AMap.Driving : mode === 'walk' ? AMap.Walking : AMap.Transfer;
        resolve(Cls);
      });
    }).catch(reject);
  });
}

/** 加载高德逆地理编码插件(反查坐标所在城市, V6.3) */
export function loadGeocoder(): Promise<any> {
  return new Promise((resolve, reject) => {
    loadAMap().then((AMap) => {
      AMap.plugin('AMap.Geocoder', () => {
        resolve(AMap.Geocoder);
      });
    }).catch(reject);
  });
}

declare global {
  interface Window {
    AMap: any;
  }
}