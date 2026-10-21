import { defineConfig } from 'tsdown'

/**
 * 仅 Node 的后端。Win32 对话框 worker 构建为自己的 CJS 入口，由驱动按路径加载，
 * 内联对话框逻辑，而 koffi 保持为外部的原生 require。
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    // 产物是 lib/worker.cjs（workspace 约束所依据的 ./worker 导出），
    // 由描述性的源码入口打包而来。
    entry: { worker: 'lib/types/win32-dialog-worker.js' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
