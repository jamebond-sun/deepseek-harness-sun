# ESM、pnpm workspace、Project References 与 source/artifact plane

这四个概念经常同时出现在 TypeScript monorepo 中，但它们解决的是不同问题：ESM 规定 JavaScript 模块如何运行，pnpm workspace 管理多个包及其依赖，TypeScript Project References 管理编译项目图，source plane 与 artifact plane 区分代码检查时使用源码还是构建产物。把它们放在一起看，才能理解一个包如何从 `src/` 被开发、编译、测试并最终被其他包消费。

本文是中文学习笔记，面向刚接触多包 TypeScript 项目的读者，示例核对自 `B:/deepseek-harness-sun` 当前工作树（2026-10-19）。配置片段注明为节选时，不是可直接替换原文件的完整配置。

## 目录

- [一张总图](#一张总图)
- [ESM：模块运行规则](#esm模块运行规则)
- [pnpm workspace：包和依赖的管理范围](#pnpm-workspace包和依赖的管理范围)
- [TypeScript Project References：编译项目图](#typescript-project-references编译项目图)
- [source plane 与 artifact plane：检查时使用哪份代码](#source-plane-与-artifact-plane检查时使用哪份代码)
- [用 storage-json 串起完整关系](#用-storage-json-串起完整关系)
- [对比表](#对比表)
- [常见误解与排查](#常见误解与排查)
- [练习与参考文件](#练习与参考文件)

## 一张总图

```text
pnpm workspace
  发现 packages/*/*，安装依赖，连接工作区包
        |
        v
TypeScript Project References
  根据 tsconfig.json 的 references 排定编译顺序

检查所选的解析方式：
source plane                         artifact plane
  读取 src/ 和源码类型                 读取 lib/、.d.ts 和打包入口
  用于开发、源码检查、单元测试           用于构建消费者、发布路径检查
        |                              ^
        +---------- build:artifacts ----+

ESM 贯穿运行时：package.json 的 "type": "module" 和 exports
决定生成的 JavaScript 如何被 Node.js 或其他消费者加载。
```

最容易混淆的是：pnpm workspace 处理“包怎么找到”，Project References 处理“项目怎么编译”，ESM 处理“模块怎么运行”，source/artifact plane 处理“检查时读哪一份代码”。它们可以协作，但不能互相替代。

## ESM：模块运行规则

ESM（ECMAScript Modules）是 JavaScript 的标准模块系统。模块使用 `export` 暴露值，使用 `import` 依赖其他模块：

```ts
// math.ts
export function add(a: number, b: number): number {
  return a + b;
}

// app.ts（本项目的 .ts 相对导入写法）
import { add } from './math.ts';

console.log(add(1, 2));
```

Node.js 通常通过 `package.json` 的 `"type": "module"` 将 `.js` 解释为 ESM。本项目根 `package.json` 和各个发布包（例如 `packages/storage/storage-json/package.json`）都声明了这个字段；包还用 `main`、`types` 和 `exports` 指向构建后的 JavaScript 与声明文件。

上面的代码块展示两个独立文件。ESM 是 JavaScript 的模块机制；参数上的 `: number` 属于 TypeScript 类型语法，两者可以同时使用。

需要区分通用实践和本项目约定：有些 Node.js TypeScript 项目在源码中写 `./math.js`，由 TypeScript 找到对应的 `.ts`；本项目的本地相对导入写 `.ts`。例如 `storage-json/src/index.ts` 的真实导入为：

```ts
import { openSingleUnit } from './single-unit.ts';
import { openPerRecordUnit } from './per-record-unit.ts';
```

`tsconfig.base.json` 启用 `allowImportingTsExtensions` 和 `rewriteRelativeImportExtensions`，编译时会重写相关相对扩展名；`tsdown.config.ts` 还声明 `format: ['esm']`，生成 ESM 运行时 bundle。不能只根据 ESM 就断定 TypeScript 源码必须写哪种扩展名，还要看编译器与执行工具。

与旧的 CommonJS（CJS）对比：

| 内容 | ESM | CommonJS |
| --- | --- | --- |
| 导入 | `import { add } from './math.js'` | `const { add } = require('./math.cjs')` |
| 导出 | `export { add }` | `module.exports = { add }` |
| Node.js 常见识别方式 | `.mjs`，或 `type: module` 下的 `.js` | `.cjs`，或按 CommonJS 解释的 `.js` |

ESM 的静态导入有利于工具分析依赖并进行 tree shaking，但不会自动保证打包结果删除无用代码；ESM 也支持 `import()` 动态导入。`"type": "module"` 不会替你编译 TypeScript、安装依赖或改写导入路径。

## pnpm workspace：包和依赖的管理范围

pnpm workspace 把一个仓库视为多个相互依赖的包。根目录的 `pnpm-workspace.yaml` 声明工作区成员，本项目包含 `packages/*/*`、`apps/*`、`vendor/*`、`native/system` 等路径。

包名由 `package.json` 的 `name` 决定，不由目录名决定：`packages/storage/storage` 的包名是 `@deepseek-ai/dsh-storage`，`packages/storage/storage-json` 的包名是 `@deepseek-ai/dsh-storage-json`。跨包导入使用包名；包内部相对导入使用 `.ts` 路径。

包通过自己的 `package.json` 声明依赖。下面节选自 `storage-json/package.json`，其中 `storage` 是 peer dependency，也列在开发依赖中，以便本包开发和编译：

```json
{
  "peerDependencies": {
    "@deepseek-ai/dsh-storage": "workspace:*"
  }
}
```

`workspace:*` 要求使用工作区内的包；缺失时不会悄悄改用 npm 上的同名包。`workspace:~` 同样要求工作区包，打包或发布时使用对应版本的 `~` 范围；`workspace:*` 会转换为对应的确切版本。例如，假设本地包版本为 `1.2.3`，两者分别转换为 `~1.2.3` 和 `1.2.3`。本项目的 Harness 包使用 `workspace:*`，vendor/native 包使用 `workspace:~`，范围选择不是 ESM 规则。

pnpm 负责安装依赖、维护根部的 `pnpm-lock.yaml`，并把工作区包连接起来。`dependencies` 表示包需要的运行时依赖，`devDependencies` 表示开发所需依赖，`peerDependencies` 表示要求使用方提供兼容依赖；workspace 协议可以用于这些声明，其含义与依赖类别分开理解。

以下命令在仓库根目录执行，展示不同层次的操作；这里没有要求重新安装依赖：

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-storage-json exec tsc -b --dry
pnpm run build:artifacts
pnpm run build:check
```

这些命令分别用于安装工作区、查看一个包的 TypeScript 项目引用、生成仓库构建产物以及检查构建消费者。它们不会改变 Node.js 对 ESM 的解释方式。

`--filter` 选择包，`exec` 在选中的包环境中执行工具，`run` 执行 `package.json` 定义的脚本。`storage-json` 没有自己的 `build` 或 `test` 脚本，因此不能凭包名假定 `pnpm --filter @deepseek-ai/dsh-storage-json build` 会构建它；本项目使用根脚本组织这部分构建。

## TypeScript Project References：编译项目图

Project References 是 `tsconfig.json` 中的 `references` 数组。它把大型 TypeScript 工程拆成多个可独立构建的项目，并让 `tsc -b` 按依赖顺序构建。

本项目的 `packages/storage/storage-json/tsconfig.json` 直接引用了 `../storage`，也引用了 vendor 中的 Cordis、Cosmokit 和 Schemastery。以下为保留继承关系的节选：

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "references": [
    { "path": "../../../vendor/cosmokit" },
    { "path": "../../../vendor/cordis" },
    { "path": "../../../vendor/schemastery" },
    { "path": "../storage" }
  ]
}
```

这表示 `storage-json` 的 TypeScript 编译依赖 `storage` 的项目输出和类型声明。根部的 `tsconfig.host.json` 还把大量包配置为整个 Host 编译图的引用。Project References 关注的是 TypeScript 的构建顺序、增量构建和声明文件边界；它不等同于 `package.json` 的依赖声明，运行时仍需要正确的 workspace/package 依赖和 ESM 入口。

被引用项目需要启用 `composite`。这里通过基础配置继承了 `composite: true`、`declaration: true` 和 `incremental: true`；增量信息允许构建工具判断哪些项目需要更新。构建模式使用 `tsc -b`，而 `tsc -p` 检查指定项目，不会递归替你构建引用项目。

根部 `tsconfig.json` 是 solution 配置，自己不包含源文件：

```json
{
  "extends": "./tsconfig.base.json",
  "files": [],
  "references": [
    { "path": "./tsconfig.host.json" },
    { "path": "./tsconfig.client.json" }
  ]
}
```

Host 和 Client 被分成不同 TypeScript 程序，是因为两侧会扩展同一个 Cordis `Context` 接口，却在同名属性下提供不同服务；把它们放进一个程序可能产生类型冲突。Host/Client 是执行环境和编译程序的区分，source/artifact 是代码解析对象的区分，两组概念不是一一对应。

`references` 和 `paths` 也不同。例如基础配置中的源码映射节选为：

```json
{
  "compilerOptions": {
    "paths": {
      "@deepseek-ai/dsh-storage": ["./packages/storage/storage/src"],
      "@deepseek-ai/dsh-storage-json": ["./packages/storage/storage-json/src"]
    }
  }
}
```

`paths` 告诉 TypeScript 去哪里解析导入，`references` 告诉它哪些文件属于另一个编译项目。`paths` 本身不会改写发出的包名导入，也不会让普通 Node.js 自动认识别名；运行时仍需包安装、`exports` 或明确支持映射的工具。即使包的 `package.json` 已声明依赖，也不代表 `references` 会自动生成。

## source plane 与 artifact plane：检查时使用哪份代码

### Source plane

source plane 按源码位置解析工作区导入，适合源码分析、静态检查和单元测试。本项目的 `tsconfig.base.json` 提供源码 `paths`，Vitest 的解析配置使用它。目标是让检查关注当前工作树的实现，而不是依赖未声明的旧构建输出。

这里的“平面”是项目组织检查流程时使用的术语，不是 TypeScript 或 pnpm 提供的开关。源码解析也不保证每个 TypeScript 程序都直接纳入全部依赖源码：使用 Project References 的编译程序可以在被引用项目处消费声明输出，具体行为取决于执行模式和配置。

### Artifact plane

artifact plane 读取构建后的 `lib/`、`.d.ts`、JavaScript bundle 和 `package.json` 的 `exports` 入口。它适合验证“一个外部消费者安装并加载这个包时是否真的可用”，也适合检查构建产物中的类型声明、ESM 入口和文件清单。

本项目把两步分开：`pnpm run build:artifacts` 生成构建产物；`pnpm run build:check` 运行 Host/Client 聚合程序的 `tsc -p`，让测试、脚本等消费者针对已生成的包声明进行类型检查。后者不会自动重建缺失或过期的输出，缺失时可能出现编译错误，过期时则可能检查到旧类型。

`build:check` 是消费者的类型检查，不等于执行所有构建后的运行时测试，也不等于完成发布包安装验证。包入口、打包文件清单和运行时加载仍有各自的检查。

本项目要求源码检查与构建消费者检查明确声明所需输入。例如，源码分析意外解析到旧 `lib/`，可能漏掉新代码；消费者检查被 `paths` 绕回源码，又可能掩盖漏发文件或错误的 `exports`。规则关注的是输入来源、检查目的和构建依赖，不是说使用声明输出的消费者程序不能包含自己的测试源码。

## 用 `storage-json` 串起完整关系

`packages/storage/storage-json` 是一个 JSON 文件存储后端，它依赖工作区内的 `@deepseek-ai/dsh-storage`。

1. **pnpm workspace 找到包。** `pnpm-workspace.yaml` 将 `packages/*/*` 纳入工作区；`storage-json/package.json` 用 `workspace:*` 声明 `@deepseek-ai/dsh-storage`，所以本地开发时使用仓库中的 `packages/storage/storage`。
2. **Project References 排定编译关系。** `storage-json/tsconfig.json` 的 `{ "path": "../storage" }` 告诉 TypeScript 先准备 `storage` 项目，再检查和构建 `storage-json`。
3. **source plane 支持开发。** 编辑 `storage-json/src` 或 `storage/src` 时，源码类型检查可以直接沿源码依赖图工作，反馈当前工作树的代码变化。
4. **构建生成产物。** `tsc` 把 JavaScript 和 `.d.ts` 输出到 `lib/types`（目录名不代表里面只有类型）；Host 阶段的 `tsdown` 再消费其中的 JavaScript，输出 `lib/index.js`。包的公开类型入口则是 `lib/types/index.d.ts`。
5. **ESM 负责加载。** 两个包的 `package.json` 都声明 `"type": "module"`，因此构建出的 `.js` 按 ESM 规则加载；`exports` 同时规定消费者能访问的运行时和类型入口。
6. **artifact plane 验证发布形态。** 构建完成后，消费者检查应从 `lib/index.js` 和 `lib/types/index.d.ts` 验证入口，而不是只验证 `src` 中存在的实现。

可以把这个过程记成：

```text
package.json / pnpm-workspace.yaml
  -> 找到工作区包和包依赖
tsconfig.json references
  -> 排定 TypeScript 编译项目图
src/
  -> source plane 中开发和源码检查
build:artifacts
  -> 生成 lib/ 与 .d.ts
lib/ + exports + type: module
  -> artifact plane 中按 ESM 发布形态被消费
```

同一个包名导入，在不同检查中可以指向不同文件：

```text
import { StorageError } from '@deepseek-ai/dsh-storage'
                  |
     +------------+--------------------+
     |                                 |
源码解析 paths                  包入口 / 已生成声明
packages/storage/storage/src    lib/index.js 或 lib/types/index.d.ts
```

包管理器提供包的安装位置，TypeScript/测试工具的解析配置决定检查时读源码还是声明，Node.js 则根据包入口加载运行时 JavaScript。这就是为什么同一句 `import` 不能单独说明它属于哪个平面。

## 对比表

| 概念 | 主要问题 | 本项目中的主要文件 | 典型结果 |
| --- | --- | --- | --- |
| ESM | JavaScript 模块如何导入、导出和运行 | `package.json` 的 `type`、`main`、`exports`；源码中的 `import`/`export` | Node.js 按 ESM 加载 `.js` |
| pnpm workspace | 多个包如何安装、连接和运行脚本 | `pnpm-workspace.yaml`、各包 `package.json` | `workspace:*` 依赖本地包 |
| Project References | TypeScript 项目按什么顺序编译 | 各包 `tsconfig.json` 的 `references` | `tsc -b` 构建项目图和声明输出 |
| source plane | 开发和源码检查读取什么 | 各包的 `src/`、源码解析配置 | 看到工作树中的最新源码 |
| artifact plane | 发布形态和构建消费者读取什么 | `lib/`、`.d.ts`、`exports`、构建脚本 | 验证实际可发布的入口 |

## 常见误解与排查

| 现象或误解 | 先检查什么 | 原因 |
| --- | --- | --- |
| 配了 `paths`，普通 Node.js 还是找不到包 | 包是否安装、`exports` 是否正确、产物是否存在 | `paths` 不替 Node.js 改写导入 |
| 写了 `workspace:*`，类型声明还是缺失 | 引用图及最新构建是否完成 | 工作区连接不会生成 `.d.ts` |
| 只运行 `build:check`，结果仍是旧类型 | 是否在最新源码之后运行 `build:artifacts` | 聚合检查不会替你重建引用 |
| 源码测试通过，发布消费者失败 | `files`、`exports` 和构建产物 | 源码检查无法覆盖漏发入口 |
| `type: module` 以后就能任意直接运行 `.ts` | 支持的 Node.js 版本、源码加载工具、编译配置 | ESM 模式与 TypeScript 执行能力是两个问题 |
| Client 就是 source plane，Host 就是 artifact plane | 分开确认执行环境和输入文件来源 | 两者是不同维度 |

选择检查时，可以按下面的问题定位：

- 想决定模块语法、Node.js 加载方式或包的公开入口时，查看 ESM 和 `package.json`。
- 想新增一个包、连接本地包或按包运行脚本时，查看 pnpm workspace 和 `package.json`。
- 想拆分编译单元、声明依赖顺序或启用增量构建时，查看 Project References 和 `tsconfig.json`。
- 想写源码测试或静态检查时，明确它属于 source plane。
- 想验证发布包、构建消费者、类型声明和 `exports` 时，先生成 artifact，再明确在 artifact plane 检查。

## 练习与参考文件

可以用三个小问题检验理解：

1. 给 `storage` 增加一个导出后，为什么其他包源码可能已能看到它，而已构建消费者仍看不到？因为两者可能分别读取最新 `src` 和旧 `.d.ts`。
2. 删除 `storage-json` 的 project reference，保留 workspace 依赖，pnpm 是否负责修复 TypeScript 编译图？不会，包依赖图和编译图需要分别维护。
3. 构建产物存在，是否意味着 Node.js 一定能通过包名导入？还需要包安装关系、合法的入口声明以及可加载的 JavaScript。

以下链接相对本笔记目录指向当前仓库，可按顺序对照阅读：

- [pnpm-workspace.yaml](../../pnpm-workspace.yaml)：工作区成员。
- [根 package.json](../../package.json)：ESM 声明、工具版本和根构建脚本。
- [storage-json 的 package.json](../../packages/storage/storage-json/package.json)：包名、依赖类别、workspace 范围、公开入口。
- [storage-json 的 tsconfig.json](../../packages/storage/storage-json/tsconfig.json)：引用图和输出目录。
- [storage-json 的源码入口](../../packages/storage/storage-json/src/index.ts)：真实的包名导入和 `.ts` 相对导入。
- [基础 tsconfig](../../tsconfig.base.json)：源码 paths、composite 与扩展名重写。
- [根 solution tsconfig](../../tsconfig.json)：Host/Client 聚合入口。
- [tsdown 配置](../../tsdown.config.ts)：从编译输出生成 ESM bundle。
- [开发指南](../../docs/development.md#typescript-project-layout)：编译布局和构建命令的详细职责。

## 维护说明

这是一份项目学习笔记，项目事实以链接的配置、源码和开发指南为准。配置摘录与命令含义已核对；`tsc -b --dry` 已执行，它只查看构建计划，不等于完成类型检查。

本次已执行并通过 `pnpm --filter @deepseek-ai/dsh-storage-json exec tsc -b --dry`、`pnpm run build:artifacts`（7 个步骤）和随后运行的 `pnpm run build:check`（2 个步骤）。文档的 18 个链接、4 个 JSON 片段、代码围栏、段落换行和尾部空白检查通过。`pnpm install` 仅用于说明安装职责，本次未执行。文档验证直接针对本文执行。
