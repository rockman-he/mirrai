# 历史记忆提取（聊天记录回填）

> 让分身不仅"说话像"，还记得**真正发生过什么**。
>
> 实现时间：2026-11-19 · 提交：`a4c0022`（功能）、`38bcd09`（面板上传）、`f2425c0`（覆盖提醒）、`eeef090`（删除文件）
> 验证：6.3 万条真实聊天记录全流程通过 · 全量测试零新增失败

---

## 一、为什么做这个

蒸馏管线对上传的聊天记录层层截断（上传提取 50 万字符、分析只读档位上限——标准 1 万 / 深度 3 万字符）。
一份 4 个月 6.3 万条消息的记录，**分析阶段实际只读到最前面约 1–2%**。

蒸馏产出的是"人格文档"（说话方式、决策模式、边界雷区）——它天生装不下具体事件。
用户想要的是：「TA 还记得我们 8 月一起去看过海吗」——这件事**只存在于记忆里**，
而 App 的记忆面板对上传记录是空的（日常对话提取每天最多读 50 条，且只针对实时聊天）。

方案取舍：

| 方案 | 结论 |
|---|---|
| A. 时间分层抽样导出（不改代码） | 已用 `scripts/distill_sample.py` 做过，供蒸馏用 |
| B. Map-Reduce 分批蒸馏人格 | 未做——人格文档几 KB，边际收益低 |
| **C. 分批提取情景记忆（本次实现）** | 复用记忆表 + 检索 + 记忆面板三套现成机制，**运行时零改动** |
| D. 原文检索 RAG（关键词/向量） | 未做——留作"精确引文"层的后续方向 |

关键设计纠正：不做「发现上下文缺失→才去查」（模型无法可靠自知无知，缺口会被幻觉填上），
而是**每轮常驻检索、命中才注入**——低于阈值不注入就是天然的 fallback。

---

## 二、数据流

```
记忆面板「历史记忆」→ 选文件（或就地上传）→ 预估（消息数/批数/调用次数）
  → 确认 → 后台循环：
      storageReadText 读全量字节（一次）
      → parseChatLog 解析（双格式识别 + 噪音过滤 + 假说话人防御）
      → batchChatLog 按字符预算切批（~30k 字符/批）
      → 每批调 extractMemories（复用现有管线：围栏/去重/落库）
      → 进度行写入（doneBatches / memoriesAdded / coveredUntil）
  → 面板轮询展示；现有检索每轮自动召回新记忆
```

---

## 三、使用指南（用户视角）

| 步骤 | 操作 |
|---|---|
| 入口 | 聊天页 → 更多操作 → **记忆时间线** → 顶部「**历史记忆**」按钮 |
| 上传 | 面板内下拉选择已传文件，或**直接就地上传**本地 txt/csv（蒸馏完成的分身在全应用已无其他上传入口——这是本次补的洞） |
| 预估 | 选中文件即显示「N 条消息，约 M 次调用」，费用跑在用户自己配置的 provider 上 |
| 覆盖提醒 | 面板显示「已有记忆覆盖至 X 日」——**取所有任务行的最大覆盖时间**，建议只上传该日期之后的新记录 |
| 运行中 | 进度条（done/total 批）+ 已提取条数，每 3 秒轮询；随时取消 |
| 中断/失败 | 进度保留，按钮变「继续提取」，从断点批接着跑（分批确定性：同一文件切出的批次完全一致） |
| 删除文件 | 选中文件后点「**删除所选文件**」→ 弹窗显示文件名确认。**已提取的记忆不受影响**（记忆是独立数据行）；但以后重新蒸馏不再使用该文件内容 |
| 之后 | 什么都不用做——日常聊天的每轮检索自动召回新记忆，有 top-K 上限不会撑爆 prompt |

**操作纪律**：
- 同一个文件**不要跑第二次**（模型措辞每次不同，精确去重接不住 → 近似重复）
- 新记录只传增量时段（看覆盖提醒的日期）
- 真出现重复：记忆面板单条删除；事实锚点冲突用「以这条为准」

---

## 四、模块详解

| 模块 | 文件 | 职责 | 测试 |
|---|---|---|---:|
| 日志解析器 | `server/chat/log-parse.ts` | 双格式解析、噪音过滤、假说话人防御、字符预算分批 | 16 |
| 编排器 | `server/chat/memory-backfill.ts` | 预估、启动守卫、后台循环、断点续跑、归属校验、覆盖记录 | 22 |
| 提取扩展 | `server/chat/memory-extract.ts` | `promptOverride`（回填专用 prompt）+ `withTimestamps`（行级日期） | 13 |
| 端点 ×5 | `server/routers.ts` memory 路由 | `backfillPreview / Start / Status / Cancel / Resume` | 委托已测模块 |
| 存储 | `server/storage.ts` | `storageReadText`（路径校验同上传，只读 uploads 目录内） | — |
| 数据 | `drizzle/0044`、`0045` + `drizzle/schema.ts` | `memory_backfills` 表（进度即断点）+ `coveredUntil` 列 | 元测试 |
| 客户端面板 | `client/src/components/MemoryBackfill.tsx` | 状态机：预估→运行→取消/续跑/完成，含就地上传与覆盖提醒 | 10 |

### 解析器要点（`log-parse.ts`）

- **双格式**：Moect 头格式（`[时间] 名字` 换行正文）+ 规范冒号格式（`名字：内容` 单行）。
  判别规则：时间戳后剩余部分若匹配 `名字：内容` 且名字是可信说话人 → 单行消息；否则 → 头格式，后续行是正文
- **假说话人防御**（真实文件冒烟测出的 bug：`等8：30再說` 被腰斩成说话人「等8」）：
  名字含句读/Markdown 符号、纯数字、`http(s)`、名字以数字结尾且内容以数字开头（时间表达）→ 一律不认
- **噪音过滤**：媒体占位符（`[图片]` 等）、导出说明、加好友/防诈骗系统消息、`系统` 说话人
- **分批**：纯字符预算贪心装填，消息永不拆半。注意：按对话块分批与按消息分批在贪心装填下
  **划分完全等价**（数学事实，曾被误写成两种矛盾测试——gap/跨天分块对该管线是死代码）

### 编排器要点（`memory-backfill.ts`）

- **文件读一次**：启动时全量读入内存（3.9MB 可接受），顺带免疫"跑到一半文件被删"
- **进度行即断点**：每批完成后才写进度（先落记忆再写进度——进程死在两步之间只会重读一批，反之会永久跳批）
- **取消语义**：每批前查行状态，取消后循环静默退出，**不用 done 覆盖 cancelled**
- **失败语义**：批抛错 → 行标 failed + 错误信息，进度保留可续；状态写入本身是 best-effort
- **单飞守卫**：`findActiveMemoryBackfill`（running 且 10 分钟内有心跳）拒绝并发启动；服务重启留下的僵尸行靠超时自愈
- **resume**：行必须处于 failed/cancelled；重切批次后 `startFrom = min(doneBatches, 批数)`，`startAdded` 带上旧计数防覆盖
- **覆盖记录**：每批进度写 `coveredUntil = 该批最后一条消息时间`；面板取 `MAX(所有行)`（跨文件、含中断的部分处理）

### 与既有机制的协作（运行时零改动的原因）

- 复用 `extractMemories` 的 `history` 入口：material 围栏防注入、严格 JSON 解析
  （解析失败 ≠ 空结果）、与现有记忆的标题+描述精确去重、provider 归属与重试策略
- `speakerName` 对非标准 role **原样透传**——导出里的原始名字直接给模型看，
  配合 prompt 里说明"哪边是分身"，避免脆弱的名字→角色映射启发式
- `我/TA`（规范格式）映射到 `user/assistant`，走 speakerName 的正规渲染

---

## 五、成本与规模（真实数据）

| 指标 | 数值 |
|---|---|
| 原始文件 | 3.9MB，63,603 条消息（4 个月） |
| 解析后 | 56,894 条（剔噪 ~6,700），164ms |
| 批数 | **79 批 ≈ 79 次模型调用**（30k 字符/批） |
| 预计产出 | 每批上限 10 条 → 数百条记忆 |
| 检索开销 | 每轮加载该分身全部记忆打分（数百条同现有量级），注入有 top-K 上限 |

---

## 六、部署

- **Dockerfile 无需改动**：服务端代码进 `dist/`，schema+迁移由入口脚本的
  `drizzle-kit push --force` + `migrate.mjs` 自动应用（双保险），零新依赖（纯 Node）、零新环境变量
- `.dockerignore` / `.gitignore` 已排除 `chat_record/`（本地私密聊天记录不进构建上下文、不进仓库）
- 新版本部署后功能入口与历史数据完全兼容

---

## 七、测试与验证记录

- 全部模块 TDD（先红后绿）；触及套件 432 测试全绿；`tsc` 干净；`audit:i18n` 0 裸中文
- 真实文件冒烟：63,603 → 56,894 条 / 79 批 / 164ms；修复时间表达假说话人 bug（修复前 170+ 垃圾说话人）
- 全量测试对比：**基线 26 失败 → 改动后 19 失败**（差的 7 个来自顺手修复的 CRLF 问题），零新增失败
- 顺手修复：`db-delete-coverage.test.ts` 的闭括号正则只认 LF，Windows（`core.autocrlf`）检出必挂——改为行尾无关

## 八、存量问题记录（本次未修，基线确认）

- 约 19 个环境性测试失败：`filename`×3（路径分隔）、`i18n` WeChat 协议×1（路径分隔）、
  bootstrap/macos/schema-coverage（chmod/.env，POSIX 专属）、collectors Python 系 ×10+
  （Windows 下 Python 子系统差异）；`storage.test.ts` 并行跑时偶发 2 个 chmod 假失败（单跑全绿）
- `db-migrations.test.ts` 列覆盖正则不认**跨行**的 `ALTER TABLE ... ADD COLUMN`（0043 等旧迁移全踩）；
  新迁移已约定写成单行
- `i18n` 假说话人防御类关键词表需 `// i18n:allow-input` 逐声明豁免（`log-parse.ts` 三处、`memory-backfill.ts` 一处）

## 九、后续方向（未做，按优先级）

1. **起始日期过滤**：面板加日期输入，编排器按 `batches[i].start >= date` 跳过旧批——
   全量导出无需手工剪文件（分批已带起止时间，十几行的事）
2. **方案 D：原文检索 RAG**——"TA 当时原话怎么说"级别的精确引文召回
   （`collectedMessages` 表 + `createCollectedMessages` 批量写入是现成地基；检索哲学仍是
   依赖免费关键词评分，见 `retrieval.ts:8`）
3. 跨批**近似去重**（现有去重是精确匹配；同一事件换说法会产生重复，靠面板手动清理）
4. 相似度去重 + 对同一文件重复跑的显式警告

---

## 十、相关文件速查

```
server/chat/log-parse.ts        解析 + 分批（纯函数）
server/chat/memory-backfill.ts  编排器 + 两个带校验入口 + previewBackfill
server/chat/memory-extract.ts   extractMemories（promptOverride / withTimestamps / history）
server/routers.ts               memory.backfill* 五端点 + file.delete（仅限聊天记录类型）
server/db.ts                    memoryBackfills CRUD + getBackfillCoverage + deletePersonaFile
server/storage.ts               storageReadText
drizzle/0044_*.sql / 0045_*.sql 建表 + coveredUntil
client/src/components/MemoryBackfill.tsx  面板（预估/进度/上传/续跑）
client/src/i18n/{zh,en}.ts      chat.memory.backfill.* 文案
shared/copy/prompts.ts          prompts.memoryExtractionBackfill（每批 10 条 + 时间戳说明）
shared/copy/errors.ts           errors.backfill* 三个错误键
scripts/distill_sample.py       蒸馏抽样脚本（方案 A，独立于本功能）
```
