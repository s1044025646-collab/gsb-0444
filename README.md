# OSC 消息与嵌套 Bundle 编解码核验后端

离线的 Open Sound Control（OSC 1.0 包格式）受限二进制编解码**核验**服务。
只做包格式的编码、解码、逐节点偏移查询、结构核验与算例持久化：

- **不**发送 UDP、**不**连接乐器/软件、**不**执行控制命令、**不**按时钟调度；
- 不做 OSC 地址模式匹配，地址只要求是以 `/` 开头的非空文本；
- 类型必须由类型标记字符串显式声明，**绝不**根据字节内容猜测类型。

技术栈：TypeScript（ESM）+ Node.js（内置 `node:sqlite`，免原生编译），仅 API 与 CLI，无前端。
要求 Node.js >= 22.5（开发环境为 Node 25 验证通过）。

## 支持的类型

| 标记 | 类型 | 说明 |
| --- | --- | --- |
| `i` | int32 | 有符号 32 位大端整数，范围 -2147483648..2147483647 |
| `f` | float32 | 大端 IEEE 754 单精度；输入为 double，按实际 float32 位模式读回（如 `0.1` 读回 `0.10000000149011612`），拒绝 NaN/Infinity 及 float32 溢出 |
| `s` | string | UTF-8、零终止、补零至 4 字节倍数；拒绝嵌入 NUL 与非法 UTF-8（严格 RFC 3629，拒绝超长编码与代理码点） |
| `b` | blob | 前置大端 int32 长度，数据后补零至 4 字节倍数 |

未知类型标记（如 `d`、`t`）直接报错 `UNKNOWN_TYPE`。

## 包格式要点（本实现严格核验）

- **消息**：地址字符串（零终止+对齐）→ 以 `,` 开头的类型标记字符串（零终止+对齐）→ 按顺序排列的参数。
- **bundle**：`#bundle` + 零字节（8B）→ 64 位无符号大端时间标签（8B）→ 若干 `元素长度(int32) + 元素`。
- 所有填充字节必须为零，填充不计入实际内容；每个字段报告起止偏移、实际值与填充长度。
- 元素长度必须为**正**、**4 字节对齐**，且元素**完全位于父容器范围内**；每个元素必须恰好解析完，
  不允许未解释尾部字节（`ELEMENT_TRAILING_BYTES` / `MESSAGE_TRAILING_BYTES`）。
- 时间标签以**十进制整数字符串**输入输出，保留原始 64 位值，范围 `0..18446744073709551615`；
  `1` 表示立即执行（immediately）。本服务**不**换算日历时间、**不**做执行时刻比较或调度。
- 容器识别只看包首是否为精确的 `#bundle\0` 八字节；字符串参数中出现 `#bundle` 文本不会被误判为 bundle。

## 大小与深度限制（`src/core/limits.ts`，`GET /api/limits`）

| 限制 | 默认值 |
| --- | --- |
| 原始包大小 | 1 MiB（1,048,576 字节） |
| 字符串 UTF-8 字节数（不含终止零） | 65,536 |
| blob 数据长度 | 65,536 |
| bundle 嵌套深度 | 16 |
| 时间标签 | 0 .. 2^64-1（`1` 为立即） |

所有长度字段读取前先做边界检查；超限返回明确错误码与字节偏移。

## 快速开始（Windows PowerShell）

```powershell
npm install
npm run build      # 编译到 dist/ 与 dist-test/
npm test           # 构建 + node:test（17 个手工字节向量测试）
npm start          # 启动 HTTP API，默认自动选择空闲端口
npm run demo       # 端到端演示（已知向量/中文/空 blob/嵌套/篡改/数据库）
```

启动后控制台打印实际地址，例如 `http://127.0.0.1:51932`。

- 指定端口：`$env:PORT=8080; npm start`（端口被占用时自动改用空闲端口）。
- 数据目录：默认 `./data`（SQLite 文件 `data/osc-reports.db`），可用 `OSC_DATA_DIR` 覆盖。

## HTTP API

仅监听 `127.0.0.1`，请求/响应均为 JSON。错误响应形如
`{"error":{"code":"NONZERO_PADDING","message":"...","offset":3,"path":"/address"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查、解析版本与限制 |
| GET | `/api/limits` | 公开限制 |
| POST | `/api/encode` | 结构化树 → 字节，body `{"node": {...}}`，返回 hex、字节数组、大小与解码报告 |
| POST | `/api/decode` | 解析，body `{"hex":"2f.."}` 或 `{"file":"C:\\..\\a.bin"}` |
| POST | `/api/verify` | 解码 + 合法包重编码逐字节一致性（`roundtrip`） |
| POST | `/api/query-offset` | body `{"hex|file":..., "offset":9}`，返回覆盖该偏移的字段 |
| POST | `/api/reports` | 保存报告，body `{"report":<decode 响应>, "groupId"?:n, "note"?:"..."}` |
| GET | `/api/reports?limit=n` | 报告列表 |
| GET | `/api/reports/:id` | 读取单个完整报告（重启后可复查） |
| GET | `/api/reports/groups/:gid` | 某修订组的全部版本 |
| POST | `/api/reports/:gid/revisions` | 用新输入在该组生成新版本 |
| GET | `/api/reports/:id/export?format=json|hex|bin&out=路径` | 导出 JSON / hex 文本 / 原始字节 |

结构化树示例：

```json
{
  "kind": "bundle",
  "timetag": "1",
  "elements": [
    { "kind": "message", "address": "/x", "args": [{ "type": "i", "value": 7 }] }
  ]
}
```

blob 参数值支持 hex 字符串（`"deadbeef"` 或 `"0x.."`，空串表示空 blob）或字节数组。

错误包同样可以保存，但其 `valid` 列为 0，永远不会被标为成功。

## CLI

```powershell
node dist/cli/cli.js encode --node node.json [--save] [--note t] [--out a.bin|a.hex]   # - 表示从标准输入读 JSON
node dist/cli/cli.js decode --hex 2f780000... | --file a.bin [--save] [--note t]      # 显示树与偏移表
node dist/cli/cli.js verify --hex .. | --file ..                                      # 核验，失败退出码 2
node dist/cli/cli.js offset --hex .. --at 9                                           # 查询偏移所属字段
node dist/cli/cli.js save --hex .. [--group id] [--note t]
node dist/cli/cli.js reports [--limit n]
node dist/cli/cli.js get <id>
node dist/cli/cli.js group <groupId>
node dist/cli/cli.js export <id> --format hex|json|bin [--out 路径]
node dist/cli/cli.js limits
```

## 已知向量（规格锚点）

- `/x` `,i` 参数 `7` → `2f7800002c69000000000007`，共 **12** 字节。
- 放入立即（timetag=1）单元素 bundle →
  `2362756e646c650000000000000000010000000c2f7800002c69000000000007`，共 **32** 字节。
- 内置综合样例（`src/core/samples.ts`）包含中文字符串、零字节 blob、两层嵌套；
  另有 0.1 舍入、空 bundle、负整数、非零填充、截断长度、未知类型、超深嵌套等测试。

测试中的字节向量是**手工逐字节拼出的大端数据**（不经过本项目编码器），并独立断言字段偏移、
总长度与拒绝位置；合法包同时验证“解码→重编码”逐字节一致。

## 持久化

SQLite 表 `reports`：`id`、`group_id`、`revision`、`valid`、`packet_size`、`parser_version`、
`raw_hex`（原始字节）、`tree_json`（节点树）、`report_json`（完整报告含字段与诊断）、`note`、
`created_at`；`(group_id, revision)` 唯一。结构修订以同组新版本保存，历史报告不被覆盖。

## 限制与刻意的不实现

- 仅支持 `i f s b`；不支持 MIDI、timetag、数组、双精度等扩展标记。
- 不做网络收发、时钟调度、地址通配匹配与任何控制副作用。
- 时间标签是不透明 64 位整数（`1` 特判为立即），不解释 NTP 分数部分。
- 仅监听本机回环地址；无鉴权（设计上为本地核验工具，请勿暴露到公网）。
- `node:sqlite` 当前在 Node 中带 Experimental 警告，不影响功能。
