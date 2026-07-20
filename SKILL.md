---
name: kimi-datasource
description: |
  通过 kimi-datasource CLI 查询外部结构化数据，并自动刷新 Kimi OAuth 凭据。用于 A股、港股、美股的行情、指数、财报、技术指标，Yahoo Finance 全球金融数据，World Bank 宏观经济指标，中国企业工商及风险信息，arXiv 或 Google Scholar 论文，以及中国法律法规和司法案例；也用于自选股行情与对比。调用具体接口前必须先运行 `kimi-datasource desc` 获取当前 API 文档。
---

# kimi-datasource

使用 `kimi-datasource` 可执行文件。不要自行拼接网关 HTTP 请求，也不要凭记忆使用可能过期的 API 名。

## 标准流程

1. 根据下表选择一个数据源。
2. 运行 `kimi-datasource desc <source> --quiet`。
3. 完整阅读返回文档中的代码格式、必填参数、枚举、默认值和批量限制。
4. 选择最符合用户请求的已记录 API。
5. 核对标识符、构造参数并调用 API。
6. 简单问题读取 `data_preview`；分析任务读取命令实际写出的所有 CSV。
7. 使用用户的语言回答，并说明重要的数据限制。

同一任务中，如果数据源和接口契约没有变化，可复用刚获取的 `desc`；切换数据源或怀疑接口已变化时重新获取。

```bash
kimi-datasource desc arxiv --quiet

kimi-datasource call arxiv <desc-中的-api> \
  --param query=RAG \
  --param max_results=5 \
  --file-path /tmp/arxiv-rag.csv \
  --quiet
```

需要让其他命令或 Agent 稳定解析结果时，优先使用 `--output json`。参数较多时，通过 stdin 传完整 JSON 对象：

```bash
printf '%s' '{"query":"RAG","file_path":"/tmp/arxiv-rag.csv"}' |
  kimi-datasource call arxiv <desc-中的-api> --json-file - --output json
```

## 数据源路由

| 用户需求 | 数据源 | 典型问题 |
|---|---|---|
| A股、港股、美股的行情、指数、财务、股东、公告、预测或技术指标 | `stock_finance_data` | 当前价格、历史走势、财报、指数收盘 |
| Yahoo Finance 全球金融数据 | `yahoo_finance` | 分析师评级、期权链、全球指数历史 |
| 跨国家宏观经济指标 | `world_bank_open_data` | GDP、通胀、人口、失业率 |
| 中国企业工商、股权、经营、知识产权或司法风险 | `tianyancha` | 股东、工商变更、专利、司法风险 |
| arXiv 预印本和论文编号 | `arxiv` | 最新论文、主题检索、论文元数据 |
| 更广泛且偏引用关系的学术检索 | `scholar` | 高引论文、作者检索、引用情况 |
| 中国法律法规和司法案例 | `yuandian_law` | 法条、司法解释、相关案例 |

本 CLI 不提供通用 Web 搜索或实时新闻。遇到这类请求时，改用环境中其他合适的数据源；没有可用来源时明确说明限制。

## 标识符与参数规则

### 证券

- 使用当前 `desc` 要求的完整代码和后缀，例如 `.SH`、`.SZ`、`.BJ`、`.HK` 或 `.US`。
- 用户只给公司名、证券存在歧义或可能刚上市时，先用权威来源核对代码。
- 无法可靠核对代码时，请用户确认；不要猜测。
- 不要静默替换成名称相近的其他证券。
- 遵守当前 `desc` 的单次 ticker 上限；超出时按确定顺序分批查询。

### 中国企业

- 调用 `tianyancha` 时使用准确的工商登记全称。
- 用户只给品牌或简称时，先走该数据源文档中的公司搜索流程。
- 同一品牌可能对应多个法律实体时，不要擅自选择。

### 文件与参数优先级

- 多数 API 要求 `file_path`；除非用户指定其他位置，否则使用 `/tmp` 下唯一且含义清晰的路径。
- 参数覆盖顺序为：`--json-file`、`--json`、重复的 `--param`、`--file-path`，后者优先。
- 将带前导零的标识符保留为字符串。
- 不要猜测最新 `desc` 中没有出现的必填参数或枚举值。

## 读取与解释结果

- 单值或少量行直接使用 `data_preview`。
- 对比、图表、计算或长列表读取命令报告的每个文件。
- 混合市场查询可能写出 `_a.csv`、`_hk.csv` 等后缀文件；以命令报告的文件列表为准，不要假设原始路径一定存在。
- 解释前核对日期、单位、币种、复权方式、报告期，以及数据属于盘中还是收盘。
- 区分“没有匹配数据”和数值为零。
- 返回时间戳或最新一行属于更早交易日时，不要声称数据是实时行情。

## 鉴权与失败处理

CLI 共用按环境隔离的 Kimi Code 凭据，并自动刷新：

```bash
kimi-datasource status
kimi-datasource login
kimi-datasource refresh
```

- 凭据缺失或被拒绝时，引导用户运行 `kimi-datasource login` 或在 Kimi Code 中执行 `/login`。
- 不要打印或查看 access token、refresh token。
- 参数错误时，根据报错和最新 `desc` 修正一次。
- 遇到 schema 自相矛盾、不支持的操作、上游空数据或后端堆栈错误时，不要反复碰撞接口；向用户说明失败，并在可用时保留 request ID。

## 自选股

用户询问“我的自选股”时：

1. 定位已安装的 skill 目录，或运行 `kimi-datasource root`。
2. 读取 `watchlist.json`。
3. 获取 `stock_finance_data` 的最新文档。
4. 按当前批量限制查询行情。
5. 同时存在 `hold_cost` 和 `hold_quantity` 时，按 `(当前价 - hold_cost) * hold_quantity` 计算浮动盈亏，并保留币种信息。

用户要求新增自选股时，先核对完整证券代码，再更新 JSON 数组。条目格式：

```json
[
  {
    "code": "600519.SH",
    "name": "贵州茅台",
    "hold_cost": 1500,
    "hold_quantity": 100
  }
]
```

`code` 和 `name` 必填；持仓成本和数量可选。

## 回答要求

- 使用用户提问时使用的语言。
- 对时效性数据标明返回的观察日期或时间戳。
- 区分数据源返回值、自己的计算和基于数据的推断。
- 不提供投资建议；答案可能影响投资决策时，说明内容属于数据分析而非投资建议。
- 正常回答不展示 trace ID；调用失败或用户要求溯源时再提供。
