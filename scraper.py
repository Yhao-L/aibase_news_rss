"""
AIbase 新闻 RSS 爬虫 v4
- 主路径：按 ID 递减扫描详情页，不依赖列表页分页（?page=2 无效时也能抓全 24h）
- 第一页仅用于解析 max_id，从 max_id 向下扫描，遇连续 N 篇早于 cutoff 则停止
- 中文发布时间按北京时间 UTC+8 解析后转 UTC，避免 8 小时偏差
- 请求失败重试 + 指数退避，关键节点有日志：max_id、扫描数、命中数、跳过数
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

    # ── 按 ID 递减扫描（不依赖列表页分页）──────────────────
    "max_scan": 500,                # 从 max_id 起最多扫描的 id 数量
    "consecutive_old_stop": 10,     # 连续 N 篇早于 cutoff 则停止，避免偶发乱序误停
    "request_retries": 3,           # 请求失败重试次数（指数退避）
}

DEFAULT_GITHUB_REPOSITORY = "Yhao-L/aibase_news_rss"


def get_feed_url() -> str:
    """返回 RSS 的公开地址；在 GitHub Actions 中随仓库地址自动变化。"""
    override = os.getenv("RSS_FEED_URL", "").strip()
    if override:
        return override

    repository = os.getenv("GITHUB_REPOSITORY", DEFAULT_GITHUB_REPOSITORY).strip()
    if repository.count("/") != 1:
        log.warning(
            "GITHUB_REPOSITORY=%r 格式无效，回退到 %s",
            repository,
            DEFAULT_GITHUB_REPOSITORY,
        )
        repository = DEFAULT_GITHUB_REPOSITORY

    owner, repo = repository.split("/", 1)
    return f"https://{owner.lower()}.github.io/{repo}/feed.xml"

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

# 北京时间 UTC+8（用于解析详情页「YYYY年M月D号 HH:MM」）
BEIJING_TZ = timezone(timedelta(hours=8))

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

    # ── 中文格式：2026年2月23号 12:42（站点为北京时间 UTC+8，解析后转 UTC）──
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
        dt_beijing = datetime(year, month, day, hour, minute, second, tzinfo=BEIJING_TZ)
        return dt_beijing.astimezone(timezone.utc)

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

    last_err = None
    for attempt in range(CONFIG["request_retries"]):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=CONFIG["timeout"])
            resp.raise_for_status()
            break
        except Exception as e:
            last_err = e
            if attempt < CONFIG["request_retries"] - 1:
                delay = (2 ** attempt) * CONFIG["request_delay"]
                log.warning(f"  列表页请求失败: {e}，{delay:.1f}s 后重试")
                time.sleep(delay)
            continue
    else:
        log.error(f"  列表页请求最终失败: {last_err}")
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


# ─── 从 URL 解析文章 id ───────────────────────────────────
def extract_id_from_url(url: str) -> int | None:
    """从详情页 URL 解析 /zh/news/<id> 或 /news/<id> 中的 id"""
    m = re.search(r"/news/(\d+)", url)
    return int(m.group(1)) if m else None


# ─── 从第一页获取 max_id（仅用于确定扫描起点）──────────────
def get_max_id_from_first_page(lang: str) -> int | None:
    """抓取列表第一页，从链接中解析所有 id，返回最大值；解析不到则返回 None"""
    cfg = URLS[lang]
    raw = fetch_page(cfg["list"], lang)
    ids = []
    for item in raw:
        aid = extract_id_from_url(item.get("url", ""))
        if aid is not None:
            ids.append(aid)
    if not ids:
        log.warning("第一页未解析到任何文章 id，将回退到列表翻页逻辑")
        return None
    max_id = max(ids)
    log.info(f"第一页解析到的 max_id: {max_id}（共 {len(ids)} 个链接）")
    return max_id


# ─── 带重试的详情抓取 ─────────────────────────────────────
def fetch_article_detail_with_retry(url: str) -> dict:
    """带指数退避重试的详情抓取；404 直接跳过不重试，失败返回 {}"""
    last_err = None
    for attempt in range(CONFIG["request_retries"]):
        try:
            log.info(f"  → 详情: {url}" + (f" (重试 {attempt + 1}/{CONFIG['request_retries']})" if attempt else ""))
            resp = requests.get(url, headers=HEADERS, timeout=CONFIG["timeout"])
            if resp.status_code == 404:
                log.info(f"    404 跳过: {url}")
                return {}
            resp.raise_for_status()
            break
        except Exception as e:
            last_err = e
            if attempt < CONFIG["request_retries"] - 1:
                delay = (2 ** attempt) * CONFIG["request_delay"]
                log.warning(f"    请求失败: {e}，{delay:.1f}s 后重试")
                time.sleep(delay)
            continue
    else:
        log.warning(f"    详情请求最终失败: {last_err}")
        return {}

    soup = BeautifulSoup(resp.text, "html.parser")

    # ── 标题：取第一个 h1 ──
    title = ""
    h1 = soup.find("h1")
    if h1:
        title = h1.get_text(strip=True)

    # ── 正文摘要 ──
    summary = ""
    for selector in ["div.post-content", "div.article-content", "div.content",
                     "div.news-content", "article", "main"]:
        el = soup.select_one(selector)
        if el:
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
    for sel in ["time[datetime]", "time"]:
        el = soup.select_one(sel)
        if el:
            pub_date = parse_date(el.get("datetime") or el.get_text(strip=True))
            if pub_date:
                break
    if not pub_date:
        full_text = soup.get_text(" ")
        m = re.search(
            r"发布时间\s*:\s*(\d{4}年\d{1,2}月\d{1,2}[号日](?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)",
            full_text,
        )
        if m:
            pub_date = parse_date(m.group(1))
    if not pub_date:
        full_text = soup.get_text(" ")
        m = re.search(r"Time\s*:\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})", full_text)
        if m:
            pub_date = parse_date(m.group(1))

    if pub_date:
        log.info(f"    日期: {pub_date.strftime('%Y-%m-%d %H:%M UTC')}")
    else:
        log.warning("    日期解析失败")

    return {"title": title, "summary": summary, "pub_date": pub_date}


# ─── 按 ID 递减扫描（主抓取路径，不依赖分页）──────────────
def fetch_news_by_id_scan(lang: str) -> list[dict]:
    """
    从第一页得到 max_id，再按 id 递减请求详情页，收集最近 time_window 内的文章。
    连续 consecutive_old_stop 篇早于 cutoff 则停止；404/解析失败则跳过并计数。
    """
    cfg = URLS[lang]
    max_id = get_max_id_from_first_page(lang)
    if max_id is None:
        log.info("回退到列表翻页逻辑 fetch_news_list")
        return fetch_news_list(lang)

    cutoff = get_cutoff() if CONFIG["time_filter_enabled"] else None
    max_scan = CONFIG["max_scan"]
    stop_threshold = CONFIG["consecutive_old_stop"]
    seen_ids = set()
    all_items = []
    consecutive_old = 0
    skip_count = 0
    scanned = 0

    log.info(f"按 ID 递减扫描: 起点 max_id={max_id}, 最多扫描 {max_scan} 个 id")
    if cutoff:
        log.info(f"时间截止: {cutoff.strftime('%Y-%m-%d %H:%M UTC')}，连续 {stop_threshold} 篇过旧则停止")

    for aid in range(max_id, max(0, max_id - max_scan) - 1, -1):
        if consecutive_old >= stop_threshold:
            log.info(f"连续 {stop_threshold} 篇早于 cutoff，停止扫描")
            break
        if len(all_items) >= CONFIG["max_items"]:
            break

        url = f"{cfg['base']}{cfg['detail_prefix']}{aid}"
        if aid in seen_ids:
            continue
        scanned += 1

        detail = fetch_article_detail_with_retry(url)
        time.sleep(CONFIG["request_delay"])

        if not detail:
            skip_count += 1
            log.info(f"    跳过 id={aid}（请求失败或非文章页）")
            continue

        # 404 等可能返回空 title，视为无效
        if not detail.get("title") and not detail.get("pub_date"):
            skip_count += 1
            continue

        seen_ids.add(aid)
        pub_date = detail.get("pub_date")

        if CONFIG["time_filter_enabled"] and pub_date is not None and pub_date < cutoff:
            consecutive_old += 1
            continue
        consecutive_old = 0

        item = {
            "title": detail.get("title") or f"Article {aid}",
            "url": url,
            "summary": detail.get("summary", ""),
            "pub_date": pub_date,
        }
        all_items.append(item)

    log.info(
        f"ID 扫描结束: 扫描 id 数={scanned}, 命中={len(all_items)}, 跳过={skip_count}, "
        f"最终收集文章数={len(all_items)}"
    )
    return all_items[:CONFIG["max_items"]]


# ─── 多页抓取主逻辑（fallback，当第一页解析不到 id 时使用）───────────────────────
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
    fg.link(href=get_feed_url(), rel="self")
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
    log.info(f"=== AIbase RSS 爬虫 v4 启动 (lang={lang}) ===")
    if CONFIG["time_filter_enabled"]:
        cutoff = get_cutoff()
        log.info(f"    时间窗口: {CONFIG['time_window_hours']}h，截止 {cutoff.strftime('%Y-%m-%d %H:%M UTC')}")

    # 1. 抓取列表（优先按 ID 递减扫描，拿不到 max_id 时回退列表翻页）
    items = fetch_news_by_id_scan(lang)
    if not items:
        log.error("未获取到任何新闻，退出")
        return

    # 2. 抓取详情：仅对尚未有完整详情的条目补全（ID 扫描已带详情则跳过）
    if CONFIG["fetch_detail"]:
        need_detail = [i for i in items if not i.get("pub_date") or not (i.get("title") and len((i.get("title") or "").strip()) > 2)]
        if need_detail:
            log.info(f"开始抓取详情 ({len(need_detail)} 篇需补全)...")
            for item in need_detail:
                detail = fetch_article_detail_with_retry(item["url"])
                if detail.get("title"):
                    item["title"] = detail["title"]
                if detail.get("summary"):
                    item["summary"] = detail["summary"]
                if detail.get("pub_date"):
                    item["pub_date"] = detail["pub_date"]
                time.sleep(CONFIG["request_delay"])
        else:
            log.info("所有条目已含详情，跳过详情抓取")

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
