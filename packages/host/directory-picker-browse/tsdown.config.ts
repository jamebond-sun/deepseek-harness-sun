import { defineConfig } from 'tsdown'

/** 仅 Node 的后端：宿主文件系统之上的列表与创建原语。 */
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
