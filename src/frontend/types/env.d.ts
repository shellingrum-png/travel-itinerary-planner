/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AMAP_WEB_KEY: string;
  readonly VITE_AMAP_JS_KEY: string;
  readonly VITE_AMAP_JS_SECRET: string;
  readonly VITE_AMAP_PROXY: string;
  readonly VITE_TRANSPORT_API?: string;
  readonly VITE_SYNC_API?: string;
  readonly VITE_LLM_BASE_URL: string;
  readonly VITE_LLM_API_KEY: string;
  readonly VITE_LLM_MODEL: string;
  readonly VITE_LLM_PROXY: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_APP_DEFAULT_CURRENCY: string;
  readonly VITE_ROUTE_CACHE_TTL_DAYS: string;
  readonly VITE_POI_SEARCH_CACHE_TTL_DAYS: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}