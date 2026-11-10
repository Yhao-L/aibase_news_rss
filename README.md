# AIbase News RSS 与 AI 新闻服务

从 [AIbase](https://news.aibase.com/zh/news) 采集近 24 小时的中文 AI 新闻全文，生成 RSS，并通过 DeepSeek 提供网页新闻对话与飞书日报。

**运行平台：Cloudflare Workers。GitHub 用于保存源码与运行测试，日常采集和推送不再依赖 GitHub Actions。**

## 订阅与体验

- [RSS 全文订阅](https://ai-news-service.sky1342866713.workers.dev/feed.xml)
- [在线 AI 新闻助手](https://yhao-l.github.io/ai-news-assistant/)
- [网页前端源码](https://github.com/Yhao-L/ai-news-assistant)
- [后端部署与接口说明](worker/README.md)

旧 `https://yhao-l.github.io/aibase_news_rss/feed.xml` 为历史静态文件，停用自动采集后不再每日更新，请订阅新地址。

## 每日流程

| 北京时间 | Cloudflare 任务 |
| --- | --- |
| 11:30 | Cron 启动采集；分步获取新闻全文并保存进度，完成后发布新 RSS |
| 12:00 | 读取已采集新闻，用 `deepseek-flash` 生成或复用当日日报，发送飞书卡片 |

采集通过 Durable Object Alarm 分步执行，每篇间隔约 1.5 秒；临时请求或解析失败有限重试，任务最多运行 25 分钟。已发布 RSS 只在新采集完整成功后替换，失败保留旧源与错误记录。

确认新闻时间窗口内没有文章时，会发布新鲜的空 RSS；网络故障、解析错误不会冒充“没有新闻”。推送保留原有同日去重和不确定发送状态保护；12:00 生成失败不会自动无限补发。

## 代码与存储

- `worker/src/collector.js`：Cloudflare 采集、全文提取、RSS 生成、进度与失败记录。
- `worker/src/core.js`：RSS 校验、24 小时过滤、模型提示词和整批 JSON 调用。
- `worker/src/digest.js`：逐条过滤模型结果、关联 RSS 来源、事件去重、排序及日报组装。
- `worker/src/service.js`：新闻对话、日报缓存、管理接口、限流和发送去重。
- `worker/src/feishu.js`：飞书 Card JSON 2.0 转换与投递。
- `worker/wrangler.toml`：11:30 采集、12:00 推送及 Durable Object 绑定。
- `scraper.py`、`tests/`：保留历史 Python 爬虫与测试，可本地手动使用。
- `.github/workflows/scraper.yml`：仅保留手动触发的历史采集，不再自动定时运行。

文章全文和已发布快照存于 Cloudflare Durable Object，模型与投递服务通过内部绑定读取，不经过 GitHub Pages。GitHub 上的测试成功不等于已部署新 Worker，后端修改需单独部署。

## 本地开发

Node.js 22 或更新版本：

```bash
cd worker
npm ci
npm test
npm run check
npm run dev
```

真实模型联调需要在被 Git 忽略的 `worker/.dev.vars` 中配置密钥，详见 [worker/README.md](worker/README.md)。

历史 Python 爬虫仍可运行：

```bash
pip install -r requirements.txt
python scraper.py
python -m unittest discover -s tests -v
```

Python 输出 `docs/feed.xml`，不会更新 Cloudflare 的生产 RSS。
