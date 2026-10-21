import { defineConfig } from 'tsdown'

/**
 * 仅 Node 的宿主部分。`./shared` 子路径（供浏览器包使用的路由路径与线上载荷类型）直接
 * 解析 tsc 产出的目录树，因此打包只有一个入口。
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
])
