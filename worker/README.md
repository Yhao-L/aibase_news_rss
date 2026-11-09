# AI 新闻服务（DeepSeek + RSS + 飞书）

源码属于 RSS 项目，独立部署为 Cloudflare Worker `ai-news-service`；不依赖 Coze。
采集与推送均在 Cloudflare 运行，GitHub 仅保存源码和执行测试。前端仍属于 `ai-news-assistant` 项目。Cloudflare Durable Object 保存当日日报、限流计数和推送状态，30 天后清理。

## 本地运行

Node.js 22 或更新版本：

```sh
npm ci
npm test
npm run check
npm run dev
```

真实模型联调：在当前目录创建被 Git 忽略的 `.dev.vars`，配置 `DEEPSEEK_API_KEY`、`ADMIN_TOKEN`；需要真实发送时再加 `FEISHU_WEBHOOK`。不要把这些值写到前端或提交 Git。
前端本地设置 `REACT_APP_API_BASE_URL=http://localhost:8787`。

## 采集与定时任务

- 北京时间 **11:30**：`30 3 * * *`，启动 `FeedCollector` 分步采集 AIbase 中文新闻。
- 北京时间 **12:00**：`0 4 * * *`，保留原日报生成与飞书推送机制。
- 新 RSS：`https://ai-news-service.sky1342866713.workers.dev/feed.xml`。服务内部通过 `FEEDS` 绑定读取，无需请求 GitHub。
- 每篇采集保存进度，间隔约1.5秒；连续请求或解析失败最多尝试3次，整个采集最多25分钟。失败保留上次成功快照及错误记录；确认窗口内无文章时发布新的空 RSS。
- 原 GitHub 定时采集停用，`scraper.yml` 仅保留手动入口，旧 Pages RSS 不再每日更新。
- 12:00 推送时间保持不变；此迁移没有新增午后自动补发计划。

## 接口

| 方法/路径 | 行为 |
| --- | --- |
| GET /feed.xml | 返回最后一次完整成功采集的 RSS 全文 |
| POST /api/admin/collect | 启动一次后台采集，返回202；并发调用复用正在运行的任务 |
| GET /api/admin/collection-status | 查询采集进度、错误和已发布 RSS 时间 |
| GET /health | 健康与配置存在性，不代表模型鉴权已通过 |
| POST /api/chat | `{message, history:[{role:"user"或"assistant",content}]}`，返回 `{content}`；普通对话不发送飞书 |
| GET /api/digests/today | 获取已生成的当日日报，不触发模型 |
| POST /api/admin/preview | 生成/读取当日日报，不发送飞书 |
| POST /api/admin/send | 生成/读取日报并发送飞书；同日已成功发送则不重复发送 |
| GET /api/admin/status | 查看当日日报及推送状态 |

`/api/admin/*` 要求 `Authorization: Bearer <ADMIN_TOKEN>`，仅后端运维使用。
公开对话按 IP 每小时最多 10 次，并设置每天总共 200 次的默认预算限制（含失败请求）；可通过 `DAILY_CHAT_LIMIT` 调整。
CORS 允许列表仅是浏览器来源控制，不是身份认证。

## 部署与切换

1. `npx wrangler login` 后运行 `npm run deploy`，创建服务和 SQLite Durable Object。
2. 用 `npx wrangler secret put DEEPSEEK_API_KEY`、`FEISHU_WEBHOOK`、`ADMIN_TOKEN` 分别保存密钥。
3. 先测试 `/health`、`/api/admin/preview`、多轮 `/api/chat`，再调用一次 `/api/admin/send` 并核对飞书群卡片。
4. 前端 `REACT_APP_API_BASE_URL` 指向该 Worker 的根地址，再发布前端。
5. 验证新服务后，移除旧 `ai-news-scheduler` 的 Coze Cron，避免两套同时推送。

采集 Cron `30 3 * * *` 为北京时间11:30，推送 Cron `0 4 * * *` 为12:00。首次部署先调用 `/api/admin/collect`，确认 `/api/admin/collection-status` 的 `collection.status` 为 `succeeded`，再验收日报。`RSS_SOURCE=legacy` 加旧 `RSS_URL` 可临时回退外部 RSS；默认 `cloudflare` 使用内部绑定，首次采集完成前会明确返回未就绪。

## 处理约束

- 原始提示词保存在 `src/digest-prompt.txt`；只替换新闻数据和北京时间。
- RSS 优先读 `content:encoded`，不截断全文；最近 24 小时过滤、去重。
- RSS 无效、超出 36 小时未更新、网络失败、模型失败不会伪装成“没有新闻”。
- 没有近 24 小时文章时直接返回两项无新闻提示；有文章时由模型判断是否符合筛选条件。
- 日报首次生成后当天复用，不会随追问重新生成。模型的链接和分数分组会校验；内容准确性仍需人工抽查。
- 飞书使用 `{msg_type:"interactive", card:卡片对象}`，不是 Coze 插件使用的序列化 `content` 参数。
- 发送前写入状态；成功写 `sent`。响应失败、超时或进程中断标记/保留 `unknown` 或 `sending`，不自动重发。先检查群消息，再由管理员处理存储状态。无法保证跨第三方网络的严格 exactly-once。
- 飞书发送无自动重试或管理员强制重发按钮，以避免不确定响应产生重复消息。
- `.dev.vars` 和生产 Secrets 各自独立，生产密钥无需打包进代码。

## 验证

`npm test` 覆盖 RSS 全文与时间过滤、模型异常、多轮历史、日报缓存、并发去重、推送不确定状态、飞书业务错误、CORS、管理鉴权和请求限流。
真实模型与真实飞书联调必须单独确认；mock 测试通过不代表生产已部署。

端到端联调（先启动本地 Worker）：

```sh
node --env-file=.dev.vars scripts/smoke.mjs
```

此命令实际调用 DeepSeek，但不发飞书。确认日报后加 `--send` 才发送正式日报。

模型固定为 `deepseek-flash`。RSS 连接失败或临时服务器错误最多重试一次；日报格式不合格时最多修订两次。链接、分组分数、条数、摘要80-120字符及明显禁止类别均进行发布前校验。超过修订次数仍不合格则报错，不发送。
