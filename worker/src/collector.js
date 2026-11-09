import {ServiceError,parseFeed,dateKey} from './core.js';

const SOURCE='https://news.aibase.com';
const FEED_URL='https://ai-news-service.sky1342866713.workers.dev/feed.xml';
const MAX_SCAN=500, MAX_ITEMS=50, OLD_STOP=10;
const xml=s=>String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const decode=s=>s.replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).replace(/&(nbsp|quot|apos|lt|gt|amp);/g,(_,n)=>({nbsp:' ',quot:'"',apos:"'",lt:'<',gt:'>',amp:'&'}[n]));

export function publicationTime(html) {
  const m=html.match(/发布时间\s*(?:[:：]|<[^>]+>|\s)*(\d{4})年(\d{1,2})月(\d{1,2})[号日]\s*(\d{1,2}):(\d{2})/);
  if(!m)throw new ServiceError('采集文章缺少发布时间');
  const [,y,mo,d,h,mi]=m.map(Number);
  return Date.UTC(y,mo-1,d,h-8,mi);
}
export function latestId(html) {
  const ids=[...html.matchAll(/href=["'](?:https:\/\/news\.aibase\.com)?\/(?:zh\/)?news\/(\+?\d+)["']/g)].map(m=>Number(m[1]));
  if(!ids.length)throw new ServiceError('新闻列表解析失败，未发现文章链接');
  return Math.max(...ids);
}
export async function parseArticle(html,id,Rewriter=HTMLRewriter) {
  let title='',content='';
  const rewritten=new Rewriter()
    .on('h1',{text(t){title+=t.text;}})
    .on('.articleContent',{text(t){content+=t.text;}})
    .on('.articleContent p, .articleContent li, .articleContent h2, .articleContent h3',{element(e){content+='\n\n';}})
    .on('.articleContent br',{element(){content+='\n';}})
    .transform(new Response(html));
  await rewritten.arrayBuffer();
  title=decode(title).trim();content=decode(content).trim();
  if(!title || !content)throw new ServiceError(`文章 ${id} 正文解析失败`);
  const article={title,content,link:`${SOURCE}/zh/news/${id}`,published:publicationTime(html)};
  if(new TextEncoder().encode(JSON.stringify(article)).length>120000)throw new ServiceError(`文章 ${id} 正文超出存储限制`);
  return article;
}
export function buildFeed(articles,builtAt) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>AIbase 中文 AI 资讯</title><link>${SOURCE}/zh/news</link><description>Cloudflare 每日采集的 AI 新闻全文</description><lastBuildDate>${new Date(builtAt).toUTCString()}</lastBuildDate>${articles.map(a=>`<item><title>${xml(a.title)}</title><link>${xml(a.link)}</link><guid isPermaLink="true">${xml(a.link)}</guid><pubDate>${new Date(a.published).toUTCString()}</pubDate><description>${xml(a.content)}</description><content:encoded>${xml(a.content)}</content:encoded></item>`).join('')}</channel></rss>`;
}

export class FeedCollector {
  constructor(ctx,env,fetcher=fetch,parser=parseArticle,clock=Date.now) {
    Object.assign(this,{ctx,env,fetcher,parser,clock});this.storage=ctx.storage;
  }
  async fetch(request) {
    try {
      const path=new URL(request.url).pathname;
      if(path==='/collect' && request.method==='POST')return Response.json(await this.start(),{status:202});
      if(path==='/status')return Response.json({collection:await this.storage.get('job')||null,published:await this.storage.get('published')||null});
      if(path==='/feed') {
        const saved=await this.storage.get('published');
        if(!saved)throw new ServiceError('RSS 尚未完成首次采集',503);
        const entries=await this.storage.list({prefix:`article:${saved.runId}:`});
        return new Response(buildFeed([...entries.values()].sort((a,b)=>b.published-a.published),saved.builtAt),{headers:{'Content-Type':'application/rss+xml; charset=utf-8','Cache-Control':'no-store'}});
      }
      return new Response('Not found',{status:404});
    }catch(e){return Response.json({message:e instanceof ServiceError?e.message:'采集服务异常'},{status:e.status||500});}
  }
  async start() {
    return this.storage.transaction(async tx=>{
      const prior=await tx.get('job');
      if(prior?.status==='running') {
        if(!await tx.getAlarm())await tx.setAlarm(this.clock()+1);
        return prior;
      }
      const now=this.clock();
      const job={runId:crypto.randomUUID(),date:dateKey(now),status:'running',startedAt:new Date(now).toISOString(),cutoff:now-86400000,cursor:null,scanned:0,count:0,old:0,missing:0,failures:0};
      await tx.put('job',job);await tx.setAlarm(now+1);return job;
    });
  }
  async page(url) {
    // Workers' global fetch must be called without the Durable Object as its receiver.
    const fetcher=this.fetcher;
    const response=await fetcher(url,{headers:{'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'zh-CN,zh;q=0.9,en;q=0.8','Referer':`${SOURCE}/`},signal:AbortSignal.timeout(15000)});
    if(response.status===404){await response.body?.cancel();return null;}
    if(!response.ok){
      const body=await response.text();
      const title=body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.slice(0,120)||'';
      throw new ServiceError(`新闻站响应 ${response.status}${title?`: ${title}`:''}`);
    }
    const html=await response.text();
    if(html.length>2000000)throw new ServiceError('新闻页面超过大小限制');
    return html;
  }
  async alarm() {
    const job=await this.storage.get('job');if(job?.status!=='running')return;
    // Keep checkpoints small; one detail request per alarm avoids a long monolithic crawl.
    // Alarms may be delivered more than once. Article keys and cursor checkpoints are idempotent.
    try {
      if(this.clock()-Date.parse(job.startedAt)>25*60000)throw new ServiceError('采集超过25分钟，保留上次成功新闻源');
      if(job.old>=OLD_STOP || job.count>=MAX_ITEMS){await this.publish(job);return;}
      if(job.cursor===null) {
        const html=await this.page(`${SOURCE}/zh/news`);
        if(!html)throw new ServiceError('新闻列表不存在');
        job.cursor=latestId(html);
      }else {
        const html=await this.page(`${SOURCE}/zh/news/${job.cursor}`);
        if(html===null)job.missing++;
        else {
          const article=await this.parser(html,job.cursor);
          if(article.published<job.cutoff)job.old++;
          else {
            job.old=0;
            if(article.published>this.clock()+300000)throw new ServiceError('文章发布时间异常');
            if(article.published<=this.clock()) {
              await this.storage.put(`article:${job.runId}:${job.cursor}`,article);job.count++;
            }
          }
        }
        job.scanned++;job.cursor--;
      }
      if(job.old>=OLD_STOP || job.count>=MAX_ITEMS)await this.publish(job);
      else if(job.scanned>=MAX_SCAN || job.cursor<=0)throw new ServiceError('扫描达到上限仍未确定新闻窗口，保留上次成功新闻源');
      else {job.failures=0;await this.storage.put('job',job);await this.storage.setAlarm(this.clock()+1500);}
    }catch(e){
      job.failures++;job.lastError=e instanceof ServiceError?e.message:`采集失败：${e.name}: ${String(e.message).slice(0,180)}`;job.lastFailureAt=new Date(this.clock()).toISOString();
      const timedOut=this.clock()-Date.parse(job.startedAt)>25*60000;
      if(job.failures>=3 || timedOut){job.status='failed';job.completedAt=new Date(this.clock()).toISOString();}
      await this.storage.put('job',job);
      if(job.status==='running')await this.storage.setAlarm(this.clock()+10000*job.failures);
      console.error('rss_collection_failed',{status:job.status,message:job.lastError});
    }
  }
  async publish(job) {
    const rows=await this.storage.list({prefix:`article:${job.runId}:`});
    const articles=[...rows.values()];
    const builtAt=new Date(this.clock()).toISOString();
    // Same validation used by the model service: no silently truncated or malformed feed.
    parseFeed(buildFeed(articles,builtAt),this.clock());
    job.status='succeeded';job.completedAt=builtAt;
    await this.storage.transaction(async tx=>{
      await tx.put('published',{runId:job.runId,builtAt,articleCount:articles.length,source:SOURCE,feedUrl:FEED_URL});
      await tx.put('job',job);
    });
    // Preserve the previous snapshot until the new one is complete. Clean abandoned runs too.
    try {
      const all=await this.storage.list({prefix:'article:'});
      const obsolete=[...all.keys()].filter(k=>!k.startsWith(`article:${job.runId}:`));
      for(let i=0;i<obsolete.length;i+=100)await this.storage.delete(obsolete.slice(i,i+100));
    }catch{console.error('rss_old_snapshot_cleanup_failed');}
    console.log('rss_collection_completed',{count:articles.length,scanned:job.scanned});
  }
}
