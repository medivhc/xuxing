/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 开发 mock 开关：'1' 启用 web/src/mock 请求拦截；未设置/其他值直连真实 /api */
  readonly VITE_API_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
