# DeepSeek Harness 学习与二次开发路线

[English](project-learning-path.md) | 中文

本教程给出一条从检出项目开始，到能够独立设计、实现、测试、部署 DeepSeek Harness 扩展的递进路线。它把仓库架构、Cordis 教程、Package 实操手册和部署指南串成一条学习主线。

## 摘要

按阶段学习，直到你能说明每个阶段的数据流、所有权、失败路径和扩展点。按每周八到十小时计算，完整路线约十二周。

## 目录

- [如何使用本教程](#how-to-use-this-tutorial)
- [项目心智模型](#the-mental-model)
- [准备工作与证据规则](#preparation-and-evidence-rules)
- [十二周课程](#twelve-week-curriculum)
- [二次开发阶梯](#second-development-ladder)
- [功能设计检查表](#feature-design-checklist)
- [部署学习](#deployment-study)
- [完成标准](#completion-standard)
- [进一步探索](#further-exploration)

<a id="how-to-use-this-tutorial"></a>

## 如何使用本教程

只阅读当前阶段列出的文件，准确执行命令，记录观察结果，并用自己的话回答问题。不要一开始通读所有 Package。建立学习日志，固定记录问题、证据、结论、不确定性和下一次实验。实验放在 tmp 或独立分支中。

<a id="the-mental-model"></a>

## 项目心智模型

DeepSeek Harness 是完全插件化的 agent harness。运行中的应用是一棵由具名 profile 和有序 bundle 层组装出的 Cordis 插件树。Plugin 通过共享上下文贡献 service、类型化事件、tool、模型适配器、持久化、策略和 UI 行为。注册是 effect，并随所属 plugin 释放。

dsh 启动器选择 web、headless、sdk、sdk-minimal 和 acp 等 profile。Profile 选择 bundle；bundle 提供可被 patch 的 Cordis 配置。Profile、home 和命令行 patch 可以替换配置而不修改实现 Package。

Agent loop 协调模型生成、tool 分发、inbox 工作、取消和生命周期。新行为通常放进 plugin、service seam、事件监听器、tool 或模型适配器。Session 日志是模型可见事实、UI 重放、SDK 投影和恢复的持久来源。新模型可见输入必须能由 Session event 重建。

<a id="preparation-and-evidence-rules"></a>

## 准备工作与证据规则

修改 packages 前，先读架构、防御性模式和相关 Package README。学习 Cordis 时完成入门和动手教程。

~~~sh
corepack enable
pnpm install
pnpm run typecheck
pnpm run test:docs
~~~

声明可观察结果的命令都要在当前检出目录实际运行。需要 DEEPSEEK_API_KEY 的命令可能跳过；跳过不等于 provider 已验证。不要 reset 工作区已有修改，用 git status、git diff 和独立分支区分实验。

<a id="twelve-week-curriculum"></a>

## 十二周课程

### 第 1 周：TypeScript、Node.js 与仓库地图

**目标。** 解释 ESM、TypeScript project reference、pnpm workspace，以及 source plane 与 artifact plane。

**阅读。** 开发指南、Package 地图、AGENTS.md、package.json、pnpm-workspace.yaml 和三种 TypeScript 配置。

**执行。** 运行 typecheck、build:artifacts 和 build:check，检查一个 Package 的源码、输出、配置和 manifest。

**观察。** 标出源码、生成物、Host/Client Package，以及各命令消费的 plane。

**回答。** 为什么 Host 与 Client aggregate 分开？为什么本地导入带 .ts？运行时入口由哪个文件拥有？

**练习。** 画出 apps/cli 到一个 Package 及其直接依赖的路径。

### 第 2 周：Cordis 基础

**目标。** 建立 plugin 生命周期模型。

**阅读。** Cordis 教程第 1 至第 7 章和入门。

**执行。** 从 tmp/cordis-tutorial 逐章运行，每次只改一个配置值。

**观察。** effect 和事件监听可撤销，inject 控制就绪，瀑布监听必须调用 next。

**回答。** Disposer 由谁拥有？注入 service 不可用时怎样？不可能引用何时失败？

**练习。** 写一个无 key plugin，注册 service、发出 event，并在 dispose 时移除两者。

### 第 3 周：Profile、Bundle、Patch 与启动

**目标。** 理解 Package 如何组成 Web、headless、SDK 和 ACP。

**阅读。** 架构中的 profile/bundle、packages/boot、packages/bundle 和配置目录。

**执行。** 运行 dsh --profile web --dump-config，与 bundle patch 比较；有 key 时启动 Web。

**观察。** 层有顺序，patch 按 id 替换或插入条目，应用通过 dsh 启动。

**回答。** 同一 id 哪层生效？为什么 sdk-minimal 是独立树？哪些选择必须是校验字段？

**练习。** 通过本地 patch 改一个非秘密设置，dump 后删除 patch。

### 第 4 周：从 CLI 到 Web

**目标。** 跟踪一个请求到达 Client。

**阅读。** apps/cli、boot/app-boot、host、client、apps/web、CLI 帮助和配置目录。

**执行。** 启动 Web，观察浏览器网络和终端输出，比较 patch 前后的配置。

**观察。** Host 拥有 Node 能力，Client 负责浏览器渲染，RPC 和 Session event 连接两端。

**回答。** 启动致命错误在哪里报告？文件系统由哪端拥有？连接传输什么？

**练习。** 画出 launcher、profile、Host、Client、Session 和 provider 的时序图。

### 第 5 周：Agent loop 与 turn 生命周期

**目标。** 把 turn 理解为状态机。

**阅读。** core/agent、core/agent-loop、runtime context 和生命周期参考。

**执行。** 使用无 key snapshot 与 loop 测试，比较完成、tool call、取消和 provider 失败。

**观察。** 工作进入 inbox，loop 选择 agent/model，流式接收、分发 tool、记录结果并可能继续。

**回答。** 哪些 event 是持久事实？取消由谁拥有？tool result 何时可见？

**练习。** 标注 input、model request、stream、tool call、tool result、next request 和 finish，并补 abort。

### 第 6 周：Session、重放与持久化

**目标。** 把 Session 当作兼容性敏感的追加日志。

**阅读。** core/session、session、persistence 包、格式状态和持久化目录。

**执行。** 重放无 key snapshot，检查 JSONL event，重启并识别重建状态。

**观察。** Reader 兼容性、单调 schema version 和已发布数据规则决定变更。UI 从 event 和 metadata 派生。

**回答。** 什么时候需要格式版本？哪些信息不记录就不能恢复？

**练习。** 为一个 event 记录 producer、consumer、持久化字段、重放行为和缺失失败。

### 第 7 周：Tool 系统与执行策略

**目标。** 构建有规范输出和可重放展示的模型 tool。

**阅读。** 工具手册、core/tools、执行流水线和第一个 tool 教程。

**执行。** 无 key 构建教程 tool，跟踪 schema、pre-execute、execute、post-execute、result 和 signal。

**观察。** execute 返回规范 JSON，render 产生模型内容，presentation metadata 提供 UI 事实，策略放在 hook/guard。

**回答。** 为什么返回结构化数据？哪些失败成为 isError？signal 已 abort 时怎样？

**练习。** 实现只读观察 tool，并证明 dispose 会移除它。

### 第 8 周：模型适配器与能力 seam

**目标。** 把 provider 协议映射为稳定流。

**阅读。** LLM 适配器手册、llm 包和能力 seam 文档。

**执行。** 检查文本、推理、tool 参数、usage、finish 分片；有凭据时运行 provider e2e。

**观察。** Adapter 保留顺序、JSON 参数增量、finish 前 usage、abort、选项错误和 replay state。Seam 有 Definition、Provider、Consumer。

**回答。** 哪些失败抛出？为什么 replay state 要显式？何时拆 Package？

**练习。** 设计确定性 fake adapter 和对应测试。

### 第 9 周：Web 展示与 Client 扩展

**目标。** 增加用户可见能力而不导入 Host 实现。

**阅读。** host、client、UI/响应式 UI skill 和 tool 展示规则。

**执行。** 跟踪 Web card 从 Session event 到 Client component，测试 loading、empty、error、窄宽和 replay。

**观察。** Host presenter 纯函数，Web card 从 event/metadata 派生，文案由 locale 拥有，不支持时回退。

**回答。** replay 需保存什么？本地化文案在哪里？未知 card 怎样回退？

**练习。** 定义 pending、success、error、replay 状态和所需字段。

### 第 10 周：测试、Snapshot 与门禁

**目标。** 选择覆盖改动的证据。

**阅读。** 测试策略、pre-push checks、邻近测试和 snapshots/AGENTS.md。

**执行。** 运行聚焦单测、无 key snapshot、build:artifacts、build:check 和 test:docs。

**观察。** Source plane 与 artifact plane 回答不同问题；模型可见改动需要 recorded evidence；CI 负责穷举矩阵。

**回答。** 哪项检查证明行为、打包和文档？为什么修 fixture 而非 normalizer？

**练习。** 为 tool 改动写最小检查矩阵。

### 第 11 周：打包与可复用扩展

**目标。** 将实验变成 Package 或 profile overlay。

**阅读。** 添加 Package、扩展模式、Package README 和发布手册。

**执行。** 比较 service、tool、bundle、Client Package，运行 metadata、constraints、typecheck、lint、build、README 检查。

**观察。** 边界按独立演进角色划分，配置需校验，安装路径各不相同。

**回答。** README 说明什么？何时需要 upgrade guide？依赖如何分类？

**练习。** 创建文件前写 Package 设计。

### 第 12 周：部署、运维与完整项目

**目标。** 部署、测量资源并交付扩展。

**阅读。** 公开部署指南、bundle README 和错误处理规则。

**执行。** 按下方链接的部署指南，检查日志、持久目录和内存，在临时 profile 中部署扩展。

**观察。** 构建和运行内存不同，持久目录需要备份，secret 需要访问控制。

**回答。** 并发 Session 会增长什么？应用重启后保留什么？哪些失败用户可见？

**练习。** 交付 README、测试、replay 证据、profile patch、部署 smoke 和回滚说明。

<a id="second-development-ladder"></a>

## 二次开发阶梯

1. 观察型 Plugin：监听 event，写有界诊断记录。
2. 简单 Tool Plugin：注册只读 schema、输出、render 和取消。
3. 策略 Plugin：通过 tool hook 增加允许、拒绝或询问。
4. Profile Overlay：通过 patch 修改 bundle 设置。
5. 上下文 Plugin：添加由 Session 事实支持的模型上下文。
6. Client 展示：增加可重放 Web card。
7. LLM Adapter：映射确定性 provider 流。
8. 持久化 Provider：通过已有 seam 保存和恢复 Session。

每个项目提交设计页、源码链接、生命周期图、失败表、聚焦测试、必要的 replay/snapshot 证据和 README。

<a id="feature-design-checklist"></a>

## 功能设计检查表

1. 哪个用户或模型结果改变？
2. 哪个扩展点拥有它？
3. 是一个 Package，还是独立 Definition、Provider、Consumer？
4. 哪些值是配置、协议常量或安全不变量？
5. 哪些事实进入模型请求，哪个 Session event 能重建？
6. 加载、HMR、取消、dispose、重启、replay 怎样工作？
7. 结构化失败是什么，谁报告，哪些工作停止？
8. Web、SDK、headless 和测试如何观察？
9. 最小测试和文档集合是什么？
10. 是否改变公共入口并需要 upgrade guide？

答不上来时先回到所属 architecture、subsystem、cookbook 或 README。

<a id="deployment-study"></a>

## 部署学习

Web 访问、认证、可信主机与 TLS 配置见[公开部署指南](user/guide/public-deployments.zh.md)。源码构建与启动步骤见[开发指南](development.zh.md)。

<a id="completion-standard"></a>

## 完成标准

能解释 dsh profile → bundle patch → Cordis plugin tree → agent loop → model adapter → tool pipeline → Session events → Host/Client projection，并说明正常和失败路径，说明已理解项目。

能在默认不改 loop 的情况下选择扩展点，定义角色，说明持久化/replay 后果，写聚焦测试计划，交付经受 dispose、重启和 clean build 的 Package 或 overlay，说明可以开始二次开发。

能从日志或 Session fixture 重现问题，找到所有者，完成最小改动，运行匹配检查并记录外部破坏，说明可以维护生产行为。

<a id="further-exploration"></a>

## 进一步探索

- [架构](architecture.zh.md)
- [Cordis 入门](cordis-primer.zh.md)与 [Cordis 教程](cordis-tutorial/index.zh.md)
- [开发指南](development.zh.md)
- [测试策略](testing.zh.md)
- [添加 Package](cookbook/adding-a-package.zh.md)
- [添加 Tool](cookbook/adding-a-tool.zh.md)
- [添加 LLM 适配器](cookbook/adding-an-llm-adapter.zh.md)
- [扩展模式](cookbook/extension-cookbook.zh.md)
- [子系统参考](subsystems/README.zh.md)

## Dev Note

本教程是学习地图，不能替代 Package 契约或生成参考。命令、默认值或行为变化时，更新所属文档并重新运行文档检查。
