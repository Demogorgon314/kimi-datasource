---
name: kimi-datasource
description: |
  通过 kimi-datasource CLI 查询 Kimi 结构化数据，并自动刷新 OAuth 凭据。用于 Wind 等证券与基金债券数据、全球宏观与官方统计、中国政府数据目录与标准、企业工商、论文、法律及财经新闻，也用于自选股查询。调用具体接口前先运行 `kimi-datasource desc` 获取当前 API 文档。
---

# kimi-datasource

使用 `kimi-datasource` 可执行文件。不要自行拼接网关 HTTP 请求，也不要凭记忆使用可能过期的 API 名。

## 标准流程

1. 用户点名数据源时直接使用；否则根据下表选择最匹配的一个。
2. 运行 `kimi-datasource desc <source> --quiet`。
3. 完整阅读返回文档中的代码格式、必填参数、枚举、默认值和批量限制。
4. 选择最符合用户请求的已记录 API。
5. 核对标识符；需要先发现字段、接口或实体时，按文档完成检索，再构造参数调用取数 API。
6. 简单问题读取 `data_preview`；分析任务读取命令实际写出的所有 CSV。
7. 使用用户的语言回答，并说明重要的数据限制。

同一任务中，如果数据源和接口契约没有变化，可复用刚获取的 `desc`；切换数据源或怀疑接口已变化时重新获取。

简单查询只选一个数据源，不要并行读取多个源的 `desc`。结果已覆盖问题时停止调用；不要为补充字段、重新格式化或交叉验证继续取数。用户明确要求跨源对比时再查询多个源。字段、接口与实体发现，以及批量限制要求的分批取数，可以在选定源内继续完成。

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
| Wind 万得证券、基金、债券、宏观与金融文档 | `wind` | 分钟线、基金净值、国债收益率、财务指标 |
| IMF 国际宏观 | `imf` | 长期汇率、CPI、GDP 预测、国际收支 |
| 恒生聚源自然语言筛选 | `gildata` | 条件选股、选基金、基金经理筛选 |
| 美国 SEC 披露文件 | `sec_edgar` | 10-K、10-Q、S-1、Form 4、13F、8-K |
| S&P Capital IQ 美股基本面 | `sp_data` | 一致预期、估值、持有人、电话会记录（受账户付费权限限制） |
| 国家数据局开放数据目录 | `china_nda` | 公共数据资源登记、各省开放数据集 |
| 国家统计局宏观指标 | `china_nbs` | 全国、省、主要城市的 GDP、CPI、人口与就业 |
| 中国标准 | `china_standards` | GB 国标、HB 行标、DB 地标、TT 团标 |
| WHO 健康统计 | `who` | 预期寿命、婴儿死亡率 |
| FAO 农业粮食 | `fao` | 粮食产量、农产品价格 |
| 联合国统计司 UNdata | `unsd` | 统计年鉴、国际贸易 |
| 欧洲央行 | `ecb` | 欧元区利率、货币供应量 |
| 欧盟统计局 | `eurostat` | 欧盟失业率、CPI |
| 联合国儿童基金会 | `unicef` | 儿童营养、免疫接种率 |
| OECD 数据 | `oecd` | 成员国经济、教育支出 |
| FRED 宏观序列 | `fred` | 美国 CPI、联邦基金利率 |
| 新华财经 | `xhcj` | 快讯、公司公告、政策新闻 |
| 财新数据库 | `caixin` | 财新新闻与数据，先检索接口 |

以上 25 个源对齐托管插件 3.4.0；`sources` 返回本地已知列表，不代表账户已获全部权限。具体 API、参数、权限和数据时效以当前 `desc` 与实际返回为准。本 CLI 不提供通用 Web 搜索；财经新闻可走 `xhcj`、`caixin` 或 Wind 文档中记录的新闻接口，其他新闻使用环境中合适的来源。

### 能力边界与发现流程

- 分钟级行情走 `wind`；普通行情快照、财务与历史价格可按需求选 `stock_finance_data` 或 `yahoo_finance`。Wind 的股票、指数和交易所基金分钟线与日/周/月历史序列是不同接口；开放式基金没有盘中分钟线。
- Wind 的 `indexes` / `indicators` 使用原生字段名。PE、PB、ROE、总市值等常用字段先通过当前 `desc` 中的 `wind_search_fields` 映射，支持别名和中文，一次查询一个字段；从返回值选择适合目标 API 的字段，不要硬猜。
- Wind 宏观指标检索只返回名称、代码、频率、单位等元数据；要数值需继续调用文档中的时间序列接口，并遵守日期区间与观察条数的互斥约束。
- `yahoo_finance` 外汇历史约限 2 年；长期汇率、CPI、GDP 预测用 `imf`。`world_bank_open_data` 适合 50 年以上的历史宏观序列。
- 国内官方统计序列用 `china_nbs`；“有哪些开放数据集”用 `china_nda`；国际口径历史与预测用世界银行或 IMF。用户指定 WHO、FAO、UNSD、ECB、Eurostat、UNICEF、OECD、FRED 时直接选对应机构源。
- `gildata` 接收自然语言筛选条件；企业工商档案用 `tianyancha`。股东或持仓在 Yahoo、SEC 13F、S&P 中的口径和深度不同，按问题选源。
- 标准用 `china_standards`，法律法规与判例用 `yuandian_law`。
- `xhcj` 偏快讯、公告与政策；`caixin` 覆盖 600+ 接口，先按当前 `desc` 调用 `caixin_api_search` 发现接口，再取数。

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
