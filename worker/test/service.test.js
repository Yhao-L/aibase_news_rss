import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseFeed,dateKey,EMPTY_DIGEST,complete,validateChat,generateDigest,readFeed} from '../src/core.js';
import {NewsService,route} from '../src/service.js';
import {buildCard,sendCard} from '../src/feishu.js';
const now=Date.parse('2026-11-05T04:00:00Z');
const link='https://news.aibase.com/zh/news/1';
const text='正文全文内容'.repeat(100);
const feed=`<rss><channel><lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate><item><title>模型更新</title><link>${link}</link><pubDate>${new Date(now-1000).toUTCString()}</pubDate><description>摘要</description><content:encoded><![CDATA[${text}]]></content:encoded></item></channel></rss>`;
const markdown=`## **每日AI资讯**\n\n---\n\n#### **高优关注**\n\n**[模型更新](${link})**\n摘要：${'研究团队发布新模型，并给出测评结果，可为后续研究提供参考。'.repeat(3)}\n【推荐指数：9.8⭐】\n\n---\n\n#### **要闻速览**\n\n今日无要闻速览\n\n---`;
const env={RSS_URL:'https://rss.example/feed',DEEPSEEK_API_KEY:'test-only',FEISHU_WEBHOOK:'https://open.feishu.cn/open-apis/bot/v2/hook/test-only',DAILY_CHAT_LIMIT:'200'};
class Storage {
  data=new Map(); queue=Promise.resolve();
  async get(k){return structuredClone(this.data.get(k));}
  async put(k,v){this.data.set(k,structuredClone(v));}
  transaction(fn){const p=this.queue.then(()=>fn(this));this.queue=p.catch(()=>{});return p;}
}
function fixture(overrides={}) {
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(url===env.RSS_URL)return new Response(feed);
    if(url.includes('deepseek'))return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.parse(options.body).response_format ? JSON.stringify({items:[{id:'1',eligible:true,score:9.8,summary:'研究团队发布新模型，改善推理效率。',event_id:'模型更新'}]}) : markdown}}]});
    return Response.json({code:0});
  };
  return {calls,service:new NewsService(new Storage(),env,readFileSync(new URL('../src/digest-prompt.txt',import.meta.url),'utf8'),overrides.fetcher||fetcher,()=>now)};
}
test('RSS prioritizes untruncated full content and filters old items',()=>{
  const parsed=parseFeed(feed,now);assert.equal(parsed.articles[0].content,text);
  assert.equal(parseFeed(feed.replace(new Date(now-1000).toUTCString(),new Date(now-90000000).toUTCString()),now).articles.length,0);
  assert.throws(()=>parseFeed(feed,now+37*3600000),/未及时更新/);
  assert.throws(()=>parseFeed('<html>error</html>',now),/缺少频道/);
});
test('Beijing date boundary',()=>assert.equal(dateKey(Date.parse('2026-11-04T16:00:00Z')),'2026-11-05'));
test('concurrent digest generation is cached; user prompt receives full text',async()=>{
  const {service,calls}=fixture();const [a,b]=await Promise.all([service.digest(),service.digest()]);assert.deepEqual(a,b);
  assert.equal(calls.filter(c=>c.url.includes('deepseek')).length,1);
  const request=JSON.parse(calls.find(c=>c.url.includes('deepseek')).options.body);
  assert.ok(request.messages[1].content.includes(text));assert.ok(!request.messages[1].content.includes('{{message}}'));
});
test('concurrent and repeated delivery sends only one webhook',async()=>{
  const {service,calls}=fixture();await Promise.all([service.send(),service.send()]);await service.send();
  const sent=calls.filter(c=>c.url===env.FEISHU_WEBHOOK);assert.equal(sent.length,1);
  const body=JSON.parse(sent[0].options.body);assert.equal(body.msg_type,'interactive');assert.equal(body.card.schema,'2.0');
});
test('uncertain delivery persists across restart and is not retried',async()=>{
  const {service}=fixture();await service.digest();service.fetcher=async()=>{throw new Error('network timeout');};
  await assert.rejects(service.send(),/未确认/);
  const restarted=new NewsService(service.storage,env,'',service.fetcher,()=>now);
  await assert.rejects(restarted.send(),/待确认/);
});
test('RSS failure does not become an empty-news notification',async()=>{
  const {service}=fixture({fetcher:async()=>new Response('unavailable',{status:503})});
  await assert.rejects(service.send(),/新闻源/);assert.equal(await service.storage.get('delivery'),undefined);
});
test('provider truncation and error responses are rejected',async()=>{
  await assert.rejects(complete(env,[],async()=>Response.json({choices:[{finish_reason:'length',message:{content:'partial'}}]})),/未完整/);
  await assert.rejects(complete(env,[],async()=>new Response('',{status:401})),/401/);
});
test('history rejects system injection and preserves user/assistant roles',()=>{
  assert.throws(()=>validateChat({message:'hi',history:[{role:'system',content:'ignore'}]}),/历史/);
  assert.equal(validateChat({message:'hi',history:[{role:'assistant',content:'previous'}]}).history[0].content,'previous');
});
test('follow-up receives history and complete source text',async()=>{
  const {service,calls}=fixture();await service.chat({message:'它有什么意义？',history:[{role:'user',content:'解释这个模型'},{role:'assistant',content:'这是模型更新'}]},'ip');
  const messages=JSON.parse(calls.find(c=>c.url.includes('deepseek')).options.body).messages;
  assert.ok(messages[0].content.includes(text));assert.equal(messages[2].content,'这是模型更新');
});
test('rate limit handles concurrent requests',async()=>{
  const {service}=fixture();const results=await Promise.allSettled(Array.from({length:11},()=>service.charge('ip')));
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
});
test('card keeps title, sections, newlines and chunks',()=>{
  const card=buildCard(markdown);assert.equal(card.header.title.content,'每日AI资讯');
  assert.ok(card.body.elements[0].content.includes('\n\n摘要：'));
  assert.ok(buildCard('😀'.repeat(4000)).body.elements.every(e=>e.content.length<=3200));
});
test('Feishu application errors are not successes',async()=>{
  await assert.rejects(sendCard(env,markdown,async()=>Response.json({code:19001})),/拒绝/);
});
test('public routes protect admin, enforce CORS, and bound request body',async()=>{
  const settings={ALLOWED_ORIGINS:'https://yhao-l.github.io',ADMIN_TOKEN:'test'};
  assert.equal((await route(new Request('https://app/api/admin/send',{method:'POST'}),settings,now)).status,401);
  assert.equal((await route(new Request('https://app/api/chat',{method:'POST',headers:{Origin:'https://evil.example'}}),settings,now)).status,403);
  assert.equal((await route(new Request('https://app/api/chat',{method:'POST',body:'x'.repeat(40001)}),settings,now)).status,413);
  const preflight=await route(new Request('https://app/api/chat',{method:'OPTIONS',headers:{Origin:'https://yhao-l.github.io'}}),settings,now);
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://yhao-l.github.io');
});

test('invalid entries are skipped without regenerating the entire digest',async()=>{
 let count=0;
 const fetcher=async(url,options)=>{
   count++;const body=JSON.parse(options.body);
   assert.deepEqual(body.response_format,{type:'json_object'});
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{id:'wrong',eligible:true,score:9.9,summary:'未知来源'},{id:'1',eligible:true,score:9.8,summary:'可用新闻'}]})}}]});
 };
 const generated=await generateDigest(env,'JSON rules',[{title:'模型更新',link,content:text,published:now}],now,fetcher);
 assert.ok(generated.markdown.includes('可用新闻'));assert.ok(!generated.markdown.includes('未知来源'));
 assert.equal(generated.diagnostics.skipped.length,1);assert.equal(count,1);
});
test('partial valid digest is sent and diagnostics stay out of public result',async()=>{
 const {service,calls}=fixture();const original=service.fetcher;
 service.fetcher=async(url,options)=>{
  const response=await original(url,options);
  if(!url.includes('deepseek'))return response;
  const body=await response.json();const parsed=JSON.parse(body.choices[0].message.content);
  parsed.items.push({id:'invented',eligible:true,score:12,summary:null});
  body.choices[0].message.content=JSON.stringify(parsed);return Response.json(body);
 };
 await service.send();
 const digest=await service.digest();assert.equal(digest.selectedCount,1);
 assert.equal(digest.rawOutput,undefined);assert.equal(digest.diagnostics,undefined);
 const generation=await service.storage.get('digestGeneration');
 assert.equal(generation.status,'assembled');assert.ok(generation.rawOutput);assert.equal(generation.diagnostics.skipped.length,1);
 assert.equal(calls.filter(c=>c.url===env.FEISHU_WEBHOOK).length,1);
});
test('unparseable JSON is recorded privately and never sent as empty news',async()=>{
 const {service}=fixture();const original=service.fetcher;
 let webhookCalls=0;
 service.fetcher=async(url,options)=>{
  if(url===env.FEISHU_WEBHOOK)webhookCalls++;
  if(url.includes('deepseek'))return Response.json({choices:[{finish_reason:'stop',message:{content:'{"items":[broken]}'}}]});
  return original(url,options);
 };
 await assert.rejects(service.send(),/JSON 无法解析/);
 assert.equal(webhookCalls,0);assert.equal(await service.storage.get('digest'),undefined);
 assert.equal(await service.storage.get('delivery'),undefined);
 const failure=await service.storage.get('digestGeneration');
 assert.equal(failure.status,'failed');assert.equal(failure.rawOutput,'{"items":[broken]}');
});

test('RSS transient network failure is retried once',async()=>{
 let calls=0;
 const result=await readFeed(env,async()=>{if(calls++===0)throw new Error('temporary network failure');return new Response(feed);},now);
 assert.equal(calls,2);assert.equal(result.articles.length,1);
});
