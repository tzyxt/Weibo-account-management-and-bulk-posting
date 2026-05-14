/// <reference types="vite/client" />

import type { WeiboAppApi } from '../preload';

declare global {
  interface Window {
    weiboApp: WeiboAppApi;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: Record<string, unknown>;
    }
  }
}
