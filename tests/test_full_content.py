import unittest
from unittest.mock import patch, Mock
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
from bs4 import BeautifulSoup
import scraper


class FullContentTests(unittest.TestCase):
    def test_full_article_survives_both_fetch_paths_and_rss(self):
        first = '这是一篇长新闻正文。' * 60
        last = '末尾重要结论不能丢失。'
        html = f'<h1>标题</h1><time datetime="2026-11-05T08:00:00Z"></time><div class="post-content"><p>{first}</p><p>{last}</p><div class="related">不应出现的推荐</div></div>'
        response = Mock(text=html, status_code=200)
        with patch('scraper.requests.get', return_value=response):
            for fetch in (scraper.fetch_article_detail, scraper.fetch_article_detail_with_retry):
                detail = fetch('https://example.com/news/1')
                self.assertTrue(detail['content'].endswith(last))
                self.assertNotIn('不应出现的推荐', detail['content'])
                self.assertEqual(len(detail['summary']), 300)
                detail['url'] = 'https://example.com/news/1'
                item = ET.fromstring(scraper.generate_rss([detail], 'zh')).find('./channel/item')
                self.assertEqual(item.findtext('description'), detail['content'])
                self.assertEqual(item.findtext('{http://purl.org/rss/1.0/modules/content/}encoded'), detail['content'])

    def test_fallback_preserves_all_paragraphs(self):
        soup = BeautifulSoup('<p>短段落</p><p>另一段正文</p>', 'html.parser')
        self.assertEqual(scraper.extract_article_content(soup), '短段落\n\n另一段正文')


if __name__ == '__main__':
    unittest.main()
