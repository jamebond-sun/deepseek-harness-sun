import { defineConfig } from 'tsdown'

// 限制运行器作为自己的入口构建（由 dsh-sandbox-local 的 win32 链按路径加载），
// 内联沙箱原语，而 koffi 保持为一个外部原生 require——与
// directory-picker-native 的 worker 入口形状相同。
export default defineConfig({
  entry: { index: 'lib/types/index.js', runner: 'lib/types/runner.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
