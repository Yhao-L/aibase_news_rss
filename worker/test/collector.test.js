import test from 'node:test';
import assert from 'node:assert/strict';
import {FeedCollector,buildFeed,latestId,publicationTime} from '../src/collector.js';
import {parseFeed,readFeed} from '../src/core.js';
import {route} from '../src/service.js';
const now=Date.parse('2026-11-09T03:30:00Z');
class Storage {
 data=new Map(); nextAlarm=null; queue=Promise.resolve();
 async get(k){return structuredClone(this.data.get(k));}
 async put(k,v){this.data.set(k,structuredClone(v));}
 async getAlarm(){return this.nextAlarm;}
 async setAlarm(t){this.nextAlarm=t;}
 async list({prefix}){return new Map([...this.data].filter(([k])=>k.startsWith(prefix)));}
 async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])this.data.delete(k);}
 transaction(fn){const task=this.queue.then(()=>fn(this));this.queue=task.catch(()=>{});return task;}
}
const article=(id,published=now-1000)=>({title:`模型 ${id}`,content:'这是全文 & 包含特殊字符 < >。'.repeat(80),link:`https://news.aibase.com/zh/news/${id}`,published});
function setup({fetcher,parser,storage=new Storage()}={}) {
 return new FeedCollector({storage},{},fetcher|| (async url=>new Response(url.endsWith('/zh/news')?'<a href="/zh/news/100">新闻</a>':'article')),parser|| (async(html,id)=>article(id,id>=99?now-1000:now-90000000)),()=>now);
}
async function finish(service,max=40){for(let i=0;i<max;i++){if((await service.storage.get('job'))?.status!=='running')return;await service.alarm();}throw new Error('collector did not finish');}
test('Chinese publication date is interpreted as Beijing time; malformed pages fail',()=>{
 assert.equal(publicationTime('<span>发布时间 :</span><span>2026年11月9号 11:30</span>'),now);
 assert.throws(()=>publicationTime('challenge page'),/发布时间/);
 assert.equal(latestId('<a href="/zh/news/99"></a><a href="https://news.aibase.com/zh/news/100"></a>'),100);
 assert.throws(()=>latestId('captcha'),/未发现/);
});
test('RSS escapes XML and round trips complete content without truncation',()=>{
 const a=article(1);const parsed=parseFeed(buildFeed([a],new Date(now).toISOString()),now);
 assert.equal(parsed.articles[0].content,a.content);assert.equal(parsed.articles[0].title,a.title);
});
test('collection persists checkpoints, resumes after restart, and only publishes a complete window',async()=>{
 const collector=setup();await collector.start();await collector.alarm();await collector.alarm();
 assert.equal(await collector.storage.get('published'),undefined);
 const resumed=setup({storage:collector.storage});await finish(resumed);
 assert.equal((await resumed.storage.get('job')).status,'succeeded');
 const response=await resumed.fetch(new Request('https://internal/feed'));
 assert.equal(parseFeed(await response.text(),now).articles.length,2);
});
test('concurrent starts share one collection',async()=>{
 const c=setup();const results=await Promise.all([c.start(),c.start()]);assert.equal(results[0].runId,results[1].runId);
});
test('failed collection retries three times and preserves the previous good feed',async()=>{
 const c=setup();await c.start();await finish(c);const prior=await c.storage.get('published');
 c.fetcher=async()=>new Response('blocked',{status:403});await c.start();await finish(c);
 assert.equal((await c.storage.get('job')).status,'failed');assert.equal((await c.storage.get('job')).failures,3);
 assert.deepEqual(await c.storage.get('published'),prior);
});
test('confirmed old articles publish a fresh empty feed instead of retaining stale weekend data',async()=>{
 const c=setup({parser:async(html,id)=>article(id,now-90000000)});await c.start();await finish(c);
 assert.equal((await c.storage.get('published')).articleCount,0);
 assert.equal(parseFeed(await (await c.fetch(new Request('https://internal/feed'))).text(),now).articles.length,0);
});
test('missing article bodies fail and never publish an empty successful feed',async()=>{
 const c=setup({parser:async()=>{throw new Error('parse failure');}});await c.start();await finish(c);
 assert.equal((await c.storage.get('job')).status,'failed');assert.equal(await c.storage.get('published'),undefined);
});
test('readFeed uses internal Cloudflare binding without GitHub requests',async()=>{
 const env={FEEDS:{idFromName:n=>n,get:()=>({fetch:async()=>new Response(buildFeed([article(1)],now))})}};
 const feed=await readFeed(env,()=>{throw new Error('must not fetch GitHub');},now);assert.equal(feed.articles.length,1);
});
test('public RSS cannot start collection; collector management requires admin token',async()=>{
 const c=setup();const env={ADMIN_TOKEN:'test',FEEDS:{idFromName:n=>n,get:()=>({fetch:(url,opt)=>c.fetch(new Request(url,opt))})}};
 assert.equal((await route(new Request('https://app/api/admin/collect',{method:'POST'}),env,now)).status,401);
 assert.equal((await route(new Request('https://app/feed.xml'),env,now)).status,503);
 assert.equal((await route(new Request('https://app/api/admin/collect',{method:'POST',headers:{Authorization:'Bearer test'}}),env,now)).status,202);
});
test('collector calls native fetch without binding a Durable Object receiver',async()=>{
 const c=setup({fetcher:async function(url){assert.equal(this,undefined);return new Response('<a href="/zh/news/100">新闻</a>');}});
 await c.start();await c.alarm();assert.equal((await c.storage.get('job')).cursor,100);
});
test('an oversized full-text window fails validation after bounded retries without publishing',async()=>{
 const c=setup({parser:async(html,id)=>({...article(id),content:'全文'.repeat(2500)})});
 await c.start();await finish(c,60);
 const job=await c.storage.get('job');assert.equal(job.status,'failed');assert.equal(job.count,50);assert.equal(job.failures,3);
 assert.equal(await c.storage.get('published'),undefined);
});
test('a long run of missing pages fails rather than reporting no news',async()=>{
 const c=setup({fetcher:async url=>url.endsWith('/zh/news')?new Response('<a href="/zh/news/900">文章</a>'):new Response('',{status:404})});
 await c.start();await finish(c,510);
 assert.equal((await c.storage.get('job')).status,'failed');assert.equal(await c.storage.get('published'),undefined);
});
