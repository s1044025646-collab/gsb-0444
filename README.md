# OSC 消息与嵌套 Bundle 编解码核验后端

受限的 Open Sound Control 离线二进制编解码服务。只做**包格式**处理：把结构化消息 / 嵌套 bundle 编成字节，从十六进制或本地文件解析回消息树，并给出逐字段偏移核验报告。**不**发 UDP、**不**连接乐器、**不**执行控制命令或按时钟调度。

技术栈：TypeScript + Node.js（内置 `node:http` 与 `node:sqlite`，无第三方运行时依赖），Windows 本地运行，不需要 Docker / WSL / 外部服务。要求 Node.js ≥ 22.5（`node:sqlite`）。

## 快速开始

```powershell
npm install        # 安装 typescript / @types/node（仅开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（手工字节向量 + API + 数据库）
npm start          # 启动 HTTP API，默认绑定 127.0.0.1 的空闲端口
npm start -- --port=8080
npm run demo       # 运行内置演示向量（已知消息、立即 bundle、中文+嵌套样例）
node dist/src/cli.js <命令>   # CLI，见下
```

数据目录默认为项目内 `data/`（可用环境变量 `OSC_DATA_DIR` 覆盖），端口可用 `PORT` 环境变量或 `--port=` 指定，默认 0（操作系统分配空闲端口）。

## 支持的类型子集

| 标记 | 含义 | 编码 |
| --- | --- | --- |
| `i` | 有符号 32 位整数 | 大端 int32，越界报 `OSC_INT_RANGE` |
| `f` | IEEE 754 float32 | 大端；非有限值报 `OSC_FLOAT_NONFINITE`，转 float32 后溢出报 `OSC_FLOAT_OVERFLOW`；普通小数有舍入，解码报告**实际位模式**的值（如 0.1 → 0.10000000149011612） |
| `s` | UTF-8 零终止字符串 | 含终止零后补零至 4 字节倍数；拒绝嵌入 NUL（`OSC_STRING_NUL`）与孤立代理项（`OSC_STRING_UNICODE`）；解码严格拒绝损坏 UTF-8（`OSC_UTF8_INVALID`） |
| `b` | 任意 blob | 前置大端 int32 长度 + 数据，按数据长度补零；JSON 中用 hex 字符串表示 |

未声明的类型一律报 `OSC_UNKNOWN_TYPE`，**不**根据字节内容猜测。消息地址只要求是以 `/` 开头的非空文本，不做 OSC 地址模式匹配。

## 包规则

- 所有字段四字节对齐；字符串/blob 的填充字节必须为零（`OSC_PADDING_NONZERO`），填充不计入内容。
- bundle = 8 字节 `#bundle\0` + 8 字节无符号时间标签 + 若干「大端 int32 长度 + 元素」。元素长度必须为正、四字节对齐、完全落在父容器内，且必须恰好解析完，不允许未解释尾部字节。
- 时间标签用十进制整数字符串表示（uint64，范围 `0` 到 `18446744073709551615`），`"1"` 表示立即；其余值原样保留，不换算日历、不做时间比较。
- 字符串内容里出现的 `#bundle` 等文本不会被误判为容器（只按结构解析）。

## 公开上限（`GET /api/health` 可查）

- 包大小：65536 字节；字符串：8192 字节；blob：32768 字节；嵌套深度：32；单 bundle 元素数：1024。解析任何长度前先做边界检查。

## HTTP API

- `GET  /api/health` — 解析器版本与上限
- `POST /api/encode` — `{packet}` → `{hex, length}`
- `POST /api/decode` / `POST /api/validate` — `{hex}` 或 `{file}` → 消息树 + 诊断（每个字段含起止偏移、实际值、填充长度）
- `POST /api/roundtrip` — 解码后重编码，报告字节是否一致
- `POST /api/packets` — `{name, hex|file}` 保存算例（错误包也保存原字节与诊断，但 `ok=false`）
- `GET  /api/packets` / `GET /api/packets/:id?version=N&format=hex` — 列表 / 读回（可导出 hex 或 JSON）
- `POST /api/packets/:id/revise` — 修订结构，自动生成新版本

结构化输入示例：

```json
{ "type": "bundle", "timetag": "1", "elements": [
  { "type": "message", "address": "/x", "args": [{ "type": "i", "value": 7 }] }
] }
```

错误响应统一为 `{ ok:false, error:{ code, message, offset? } }`，错误码见 `src/osc/errors.ts`。

## CLI

```powershell
node dist/src/cli.js encode '{"type":"message","address":"/x","args":[{"type":"i","value":7}]}'
node dist/src/cli.js decode 2f7800002c69000000000007
node dist/src/cli.js decode @packet.bin      # 从文件读
node dist/src/cli.js save 样例1 2f7800002c69000000000007
node dist/src/cli.js list / show 1 / export 1 --json --out tree.json
node dist/src/cli.js serve --port=8080
```

`decode`/`tree`/`verify` 会打印消息树、逐字段偏移表以及「重编码是否一致」。

## SQLite 存储

`data/osc.db` 两张表：`packets`（算例）与 `versions`（每次保存/修订一行：原始字节 BLOB、解析器版本、消息树 JSON、诊断 JSON、是否成功）。重启后可用 `show`/`export` 或 API 复查同一报告。

## 已知向量

- `/x` + `,i` + `7` → `2f7800002c69000000000007`（12 字节）
- 放入立即标签单元素 bundle → 32 字节（`2362756e646c6500` + `0000000000000001` + `0000000c` + 上述消息）

## 限制

- 仅支持 `i/f/s/b` 四种类型，不支持 `T/F/N/I`、int64、double、timetag 参数等。
- 时间标签不做 NTP 日历换算与调度。
- `node:sqlite` 目前带 ExperimentalWarning，不影响功能。
