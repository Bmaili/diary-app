/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const c: DefineComponent<object, object, unknown>
  export default c
}

declare const __APP_VERSION__: string
