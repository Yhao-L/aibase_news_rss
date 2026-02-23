# AIbase News RSS

自动抓取 [AIbase](https://news.aibase.com) 每日最新 AI 资讯，生成 RSS 订阅源，通过 GitHub Pages 托管。

## 📡 订阅地址

```
https://suy123xb.github.io/aibase_news_rss/feed.xml
```

## ✨ 特性

- 仅收录近 24 小时内的新闻，保持内容新鲜
- GitHub Actions 每小时自动更新，无需手动维护
- 标准 RSS 2.0 格式，兼容所有 RSS 阅读器
- 支持中英文双语（修改 `scraper.py` 中 `CONFIG["lang"]` 为 `"en"` 切换）

## 🚀 本地运行

```bash
pip install -r requirements.txt
python scraper.py
# 输出文件：docs/feed.xml
```

## ⚙️ 配置

编辑 `scraper.py` 顶部的 `CONFIG`：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `lang` | `"zh"` | 语言，`"zh"` 中文 / `"en"` 英文 |
| `max_items` | `50` | RSS 最多保留条数 |
| `time_window_hours` | `24` | 时间窗口（小时） |
| `request_delay` | `1.5` | 请求间隔（秒） |

## 📦 GitHub Pages 部署

1. 进入仓库 **Settings → Pages**
2. Source 选 `Deploy from a branch`
3. Branch 选 `main`，目录选 `/docs`，点 Save
4. 等待约 1 分钟后访问订阅地址即可
