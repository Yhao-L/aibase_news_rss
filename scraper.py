"""
AIbase 新闻 RSS 爬虫 v3
- 修复中文日期解析（2026年2月23号 12:42）
- 标题从详情页 h1 提取，避免列表页拼接摘要的问题
- ID 递推改为向旧文章方向，补全时间窗口内的历史文章
本地测试运行: python scraper.py
"""

import requests
from bs4 import BeautifulSoup
from feedgen.feed import FeedGenerator
from datetime import datetime, timezone, timedelta
import json
import time
import os
import re
import logging

# ─── 配置区 ───────────────────────────────────────────────
CONFIG = {
    "lang": "zh",                   # "zh" 中文 | "en" 英文
    "max_items": 50,                # RSS 最终保留条数上限
    "max_pages": 5,                 # 最多抓取列表页数（翻页兜底限制）
    "output_file": "docs/feed.xml",
    "request_delay": 1.5,           # 请求间隔秒数
    "timeout": 15,
    "fetch_detail": True,           # 是否抓取文章详情补全摘要/日期

    # ── 时间过滤 ──────────────────────────────────────────
    "time_filter_enabled": True,    # 是否启用时间过滤
    "time_window_hours": 24,        # 只保留最近 N 小时的文章
}

URLS = {
    "zh": {
        "list": "https://news.aibase.com/zh/news",
        "base": "https://news.aibase.com",
        "detail_prefix": "/zh/news/",   # 中文详情页路径前缀
        "feed_title": "AIbase 中文 AI 资讯",
        "feed_desc": "AIbase 每日最新 AI 新闻资讯",
        "link_pattern": re.compile(r"/(zh/)?news/(\d+)"),
    },
    "en": {
        "list": "https://news.aibase.com/news",
        "base": "https://news.aibase.com",
        "detail_prefix": "/news/",
        "feed_title": "AIbase AI News",
        "feed_desc": "Latest AI news and updates from AIbase",
        "link_pattern": re.compile(r"/news/(\d+)"),
    },
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://news.aibase.com/",
}

# 中文月份映射
ZH_MONTH = {
    "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6,
    "7": 7, "8": 8, "9": 9, "10": 10, "11": 11, "12": 12,
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
    "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12,
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# ─── 日期解析 ─────────────────────────────────────────────
def parse_date(dt_str: str) -> datetime | None:
    """解析多种日期格式，含中文日期"""
    if not dt_str:
        return None
    dt_str = dt_str.strip()

    # 剥离前缀 "发布时间 :" 或 "Time :"
    dt_str = re.sub(r"^(发布时间|Time)\s*:\s*", "", dt_str).strip()

    # ── 中文格式：2026年2月23号 12:42 ──
    m = re.search(
        r"(\d{4})年(\d{1,2})月(\d{1,2})[号日]"
        r"(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?",
        dt_str,
    )
    if m:
        year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
        hour   = int(m.group(4)) if m.group(4) else 0
        minute = int(m.group(5)) if m.group(5) else 0
        second = int(m.group(6)) if m.group(6) else 0
        return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)

    # ── 英文格式：Jan 14, 2026 或 Jan 14, 2026 09:30 ──
    dt_str_clean = re.sub(r"^Time\s*:\s*", "", dt_str).strip()
    for fmt in ["%b %d, %Y %H:%M", "%b %d, %Y"]:
        try:
            return datetime.strptime(dt_str_clean, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue

    # ── ISO / 标准格式 ──
    for fmt in [
        "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d",
    ]:
        try:
            return datetime.strptime(dt_str, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue

    return None


# ─── 时间过滤 ─────────────────────────────────────────────
def get_cutoff() -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=CONFIG["time_window_hours"])

def is_within_time_window(pub_date: datetime | None) -> bool:
    if not CONFIG["time_filter_enabled"] or pub_date is None:
        return True
    return pub_date >= get_cutoff()

def is_too_old(pub_date: datetime | None) -> bool:
    if not CONFIG["time_filter_enabled"] or pub_date is None:
        return False
    return pub_date < get_cutoff()


# ─── 抓取文章详情 ─────────────────────────────────────────
def fetch_article_detail(url: str) -> dict:
    """
    抓取单篇文章详情页，返回：
    - title:    h1 标签的标题（干净，不含摘要）
    - summary:  正文前 300 字
    - pub_date: 发布时间（datetime）
    """
    log.info(f"  → 详情: {url}")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=CONFIG["timeout"])
        resp.raise_for_status()
    except Exception as e:
        log.warning(f"    详情请求失败: {e}")
        return {}

    soup = BeautifulSoup(resp.text, "html.parser")

    # ── 标题：取第一个 h1（干净文本） ──
    title = ""
    h1 = soup.find("h1")
    if h1:
        title = h1.get_text(strip=True)

    # ── 正文摘要 ──
    summary = ""
    # aibase 详情页正文在 <main> 或包含正文的 div 里
    for selector in ["div.post-content", "div.article-content", "div.content",
                     "div.news-content", "article", "main"]:
        el = soup.select_one(selector)
        if el:
            # 排除导航、相关推荐等干扰区块
            for noise in el.select("nav, header, footer, .related, .recommend"):
                noise.decompose()
            summary = el.get_text(" ", strip=True)[:300]
            break
    if not summary:
        paras = [p.get_text(strip=True) for p in soup.find_all("p")
                 if len(p.get_text(strip=True)) > 50]
        if paras:
            summary = max(paras, key=len)[:300]

    # ── 发布时间 ──
    pub_date = None

    # 优先：标准 time 标签
    for sel in ["time[datetime]", "time"]:
        el = soup.select_one(sel)
        if el:
            pub_date = parse_date(el.get("datetime") or el.get_text(strip=True))
            if pub_date:
                break

    # 次选：全文正则匹配
    if not pub_date:
        full_text = soup.get_text(" ")
        # 中文格式：发布时间 :2026年2月23号 12:42
        m = re.search(
            r"发布时间\s*:\s*(\d{4}年\d{1,2}月\d{1,2}[号日](?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)",
            full_text,
        )
        if m:
            pub_date = parse_date(m.group(1))

    # 兜底：英文格式 Time :Jan 14, 2026
    if not pub_date:
        full_text = soup.get_text(" ")
        m = re.search(r"Time\s*:\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})", full_text)
        if m:
            pub_date = parse_date(m.group(1))

    if pub_date:
        log.info(f"    日期: {pub_date.strftime('%Y-%m-%d %H:%M UTC')}")
    else:
        log.warning(f"    日期解析失败")

    return {"title": title, "summary": summary, "pub_date": pub_date}


# ─── 单页新闻列表抓取 ─────────────────────────────────────
def fetch_page(url: str, lang: str) -> list[dict]:
    """
    抓取列表页，返回 [{title, url, pub_date}, ...]
    注意：列表页的标题会包含摘要片段，title 仅作初始占位，
    详情页抓取后会被 h1 覆盖。
    列表页如能解析到日期则填入，用于提前终止翻页判断。
    """
    cfg = URLS[lang]
    log.info(f"  抓取列表页: {url}")

    try:
        resp = requests.get(url, headers=HEADERS, timeout=CONFIG["timeout"])
        resp.raise_for_status()
    except Exception as e:
        log.error(f"  列表页请求失败: {e}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    items = []
    seen_urls = set()

    for a_tag in soup.find_all("a", href=cfg["link_pattern"]):
        href = a_tag.get("href", "")
        if not href:
            continue

        # 统一转为带语言前缀的详情 URL
        m = re.search(r"/news/(\d+)", href)
        if not m:
            continue
        article_id = m.group(1)
        full_url = f"{cfg['base']}{cfg['detail_prefix']}{article_id}"

        if full_url in seen_urls:
            continue
        seen_urls.add(full_url)

        # 列表页标题（暂用，详情页会覆盖）
        title = a_tag.get_text(strip=True)[:60] or f"Article {article_id}"

        # 列表页日期（可能有，可用于提前停止翻页）
        pub_date = None
        parent = a_tag.parent
        # 尝试在卡片容器里找日期文本
        container = parent
        for _ in range(4):  # 向上查找最多4层
            if container is None:
                break
            text = container.get_text(" ")
            m_date = re.search(
                r"(\d{4}年\d{1,2}月\d{1,2}[号日](?:\s+\d{1,2}:\d{2})?)",
                text,
            )
            if m_date:
                pub_date = parse_date(m_date.group(1))
                break
            container = container.parent

        if len(title) < 4:
            continue

        items.append({"title": title, "url": full_url, "pub_date": pub_date, "summary": ""})

    return items


# ─── 多页抓取主逻辑 ───────────────────────────────────────
def fetch_news_list(lang: str) -> list[dict]:
    cfg = URLS[lang]
    base_url = cfg["list"]
    all_items = []
    seen_urls = set()

    log.info(f"=== 开始多页抓取 (最多 {CONFIG['max_pages']} 页) ===")
    if CONFIG["time_filter_enabled"]:
        log.info(f"    时间过滤: 仅保留近 {CONFIG['time_window_hours']} 小时内的文章")

    stop_paging = False

    for page_num in range(1, CONFIG["max_pages"] + 1):
        page_url = base_url if page_num == 1 else f"{base_url}?page={page_num}"
        raw_items = fetch_page(page_url, lang)

        if not raw_items:
            log.info(f"  第 {page_num} 页无数据，停止")
            break

        new_count = filtered_count = 0
        for item in raw_items:
            if item["url"] in seen_urls:
                continue
            seen_urls.add(item["url"])

            pub = item.get("pub_date")
            if CONFIG["time_filter_enabled"]:
                if is_too_old(pub):
                    log.info(f"  ⏹ 列表页遇到超时文章，停止翻页")
                    stop_paging = True
                    break
                if is_within_time_window(pub):
                    all_items.append(item)
                    new_count += 1
                else:
                    filtered_count += 1
            else:
                all_items.append(item)
                new_count += 1

        log.info(
            f"  第 {page_num} 页: 原始 {len(raw_items)} 条，"
            f"新增 {new_count} 条，过滤 {filtered_count} 条，累计 {len(all_items)} 条"
        )

        if stop_paging or new_count == 0 or len(all_items) >= CONFIG["max_items"]:
            break

        time.sleep(CONFIG["request_delay"])

    log.info(f"=== 列表抓取完成，共 {len(all_items)} 条 ===")
    return all_items[:CONFIG["max_items"]]


# ─── 生成 RSS XML ─────────────────────────────────────────
def generate_rss(items: list[dict], lang: str) -> str:
    cfg = URLS[lang]
    fg = FeedGenerator()
    fg.id(cfg["list"])
    fg.title(cfg["feed_title"])
    fg.description(cfg["feed_desc"])
    fg.link(href=cfg["list"], rel="alternate")
    fg.link(href="https://suy123xb.github.io/aibase_news_rss/feed.xml", rel="self")
    fg.language("zh-CN" if lang == "zh" else "en")
    fg.lastBuildDate(datetime.now(timezone.utc))

    # 按发布时间降序排列（时间为 None 的排最后）
    items_sorted = sorted(
        items,
        key=lambda x: x.get("pub_date") or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )

    for item in items_sorted:
        fe = fg.add_entry()
        fe.id(item["url"])
        fe.title(item["title"] or "无标题")
        fe.link(href=item["url"])
        summary = item.get("summary") or "点击查看详情"
        fe.summary(summary)
        fe.description(summary)
        pub_date = item.get("pub_date") or datetime.now(timezone.utc)
        fe.published(pub_date)
        fe.updated(pub_date)

    return fg.rss_str(pretty=True).decode("utf-8")


# ─── 保存调试 JSON ────────────────────────────────────────
def save_debug_json(items: list[dict], path: str = "docs/debug_items.json"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    serializable = []
    for item in items:
        d = dict(item)
        if isinstance(d.get("pub_date"), datetime):
            d["pub_date"] = d["pub_date"].isoformat()
        serializable.append(d)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(serializable, f, ensure_ascii=False, indent=2)
    log.info(f"调试 JSON 已保存: {path}")


# ─── 主流程 ───────────────────────────────────────────────
def main():
    lang = CONFIG["lang"]
    log.info(f"=== AIbase RSS 爬虫 v3 启动 (lang={lang}) ===")
    if CONFIG["time_filter_enabled"]:
        cutoff = get_cutoff()
        log.info(f"    时间窗口: {CONFIG['time_window_hours']}h，截止 {cutoff.strftime('%Y-%m-%d %H:%M UTC')}")

    # 1. 抓取列表
    items = fetch_news_list(lang)
    if not items:
        log.error("未获取到任何新闻，退出")
        return

    # 2. 抓取详情：补全标题（h1）、摘要、精确日期
    if CONFIG["fetch_detail"]:
        log.info(f"开始抓取详情 ({len(items)} 篇)...")
        for item in items:
            detail = fetch_article_detail(item["url"])
            if detail.get("title"):
                item["title"] = detail["title"]          # 用 h1 覆盖列表页标题
            if detail.get("summary"):
                item["summary"] = detail["summary"]
            if detail.get("pub_date"):
                item["pub_date"] = detail["pub_date"]    # 精确到分钟
            time.sleep(CONFIG["request_delay"])

        # 详情补全后再做一次时间过滤
        if CONFIG["time_filter_enabled"]:
            before = len(items)
            items = [i for i in items if is_within_time_window(i.get("pub_date"))]
            dropped = before - len(items)
            if dropped:
                log.info(f"详情补全后再次过滤: 移除 {dropped} 条超时文章，剩余 {len(items)} 条")

    # 3. 生成并保存 RSS
    rss_xml = generate_rss(items, lang)
    out_path = CONFIG["output_file"]
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(rss_xml)
    log.info(f"✅ RSS 文件已生成: {out_path} ({len(items)} 条)")

    # 4. 保存调试 JSON
    save_debug_json(items)

    # 5. 预览
    log.info("─── 结果预览（前5条）───")
    for i, item in enumerate(items[:5], 1):
        pub = item.get("pub_date")
        pub_str = pub.strftime("%m-%d %H:%M") if pub else "无日期"
        log.info(f"  {i}. [{pub_str}] {item['title'][:50]}")
        log.info(f"       {item['url']}")
    log.info(f"=== 完成，共 {len(items)} 条 ===")


if __name__ == "__main__":
    main()
