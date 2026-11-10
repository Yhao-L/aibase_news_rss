import {readFeed,complete,generateDigest,validateChat,chatMessages,dateKey,EMPTY_DIGEST,ServiceError} from './core.js';
import {sendCard} from './feishu.js';

export class NewsService {
  constructor(storage,env,template,fetcher=fetch,clock=Date.now) {
    Object.assign(this,{storage,env,template,fetcher,clock});
  }
  async feed() {
    const now=this.clock();
    if(!this.feedCache || now-this.feedCache.at>300000) this.feedCache={data:await readFeed(this.env,this.fetcher,now),at:now};
    return this.feedCache.data;
  }
  async digest() {
    if(this.digestPending) return this.digestPending;
    this.digestPending=this.makeDigest();
    try{return await this.digestPending;}finally{this.digestPending=null;}
  }
  async makeDigest() {
    const now=this.clock(), date=dateKey(now);
    const saved=await this.storage.get('digest');
    if(saved?.date===date)return saved;
    const feed=await this.feed();
    let generated={markdown:EMPTY_DIGEST,diagnostics:{format:'json-v1',inputCount:0,selectedIds:[],skipped:[],filtered:[],warnings:[],missingIds:[]}};
    try {
      if(feed.articles.length)generated=await generateDigest(this.env,this.template,feed.articles,now,this.fetcher);
    } catch(error) {
      await this.storage.put('digestGeneration',{at:new Date(this.clock()).toISOString(),status:'failed',message:error.message,diagnostics:error.diagnostics||null,rawOutput:error.rawOutput||null});
      throw error;
    }
    const {markdown,diagnostics,rawOutput}=generated;
    // Detailed model output is private: public digest responses only contain the assembled news.
    await this.storage.put('digestGeneration',{at:new Date(this.clock()).toISOString(),status:'assembled',diagnostics,rawOutput:rawOutput||null});
    console.log('digest_assembled',{inputCount:feed.articles.length,selectedCount:diagnostics.selectedIds.length,skippedCount:diagnostics.skipped.length,missingCount:diagnostics.missingIds.length});
    const result={date,markdown,generatedAt:new Date(now).toISOString(),sourceBuiltAt:feed.builtAt,articleCount:feed.articles.length,selectedCount:diagnostics.selectedIds.length};
    await this.storage.put('digest',result);
    return result;
  }
  async charge(ip) {
    const now=this.clock();
    await this.storage.transaction(async tx=>{
      const key=`rate:${ip}`, previous=await tx.get(key);
      const rate=previous && now-previous.start<3600000?previous:{start:now,count:0};
      const total=await tx.get('chatCount')||0;
      if(rate.count>=10 || total>=Number(this.env.DAILY_CHAT_LIMIT||200))throw new ServiceError('请求较多，请稍后再试',429);
      await tx.put(key,{...rate,count:rate.count+1}); await tx.put('chatCount',total+1);
    });
  }
  async chat(body,ip) {
    const {message,history}=validateChat(body);
    await this.charge(ip);
    if (/^(?:请|帮我|给我)?(?:生成|查看|看看|总结|推送)?(?:一下)?(?:今天|今日|每日)(?:有什么|有哪些|的)?(?:重要)?(?:AI|ai)?(?:新闻|资讯|日报)[？?！!。\s]*$/.test(message)) {
      const digest=await this.digest(); return {content:digest.markdown,date:digest.date};
    }
    const feed=await this.feed();
    return {content:await complete(this.env,chatMessages(history,message,feed,this.clock()),this.fetcher)};
  }
  async send() {
    if(this.sendPending) return this.sendPending;
    this.sendPending=this.deliver();
    try{return await this.sendPending;}finally{this.sendPending=null;}
  }
  async deliver() {
    const prior=await this.storage.get('delivery');
    if(prior?.status==='sent')return prior;
    // A prior in-flight attempt may have reached Feishu before this process stopped.
    if(prior && ['sending','unknown'].includes(prior.status))throw new ServiceError('上次发送结果待确认，请先核对飞书群，避免重复推送',409);
    if(!this.env.FEISHU_WEBHOOK)throw new ServiceError('尚未配置飞书 webhook',503);
    const digest=await this.digest();
    const attempt={date:digest.date,status:'sending',attemptedAt:new Date(this.clock()).toISOString()};
    await this.storage.put('delivery',attempt);
    try {
      await sendCard(this.env,digest.markdown,this.fetcher);
      const result={...attempt,status:'sent'};await this.storage.put('delivery',result);return result;
    } catch {
      await this.storage.put('delivery',{...attempt,status:'unknown'});
      throw new ServiceError('飞书发送未确认，请核对群消息和后台状态');
    }
  }
}

export const json=(body,status=200)=>Response.json(body,{status});
export function errorResponse(error) {return json({message:error instanceof ServiceError?error.message:'服务暂时不可用，请稍后重试'},error.status||500);}
export async function route(request,env,now=Date.now()) {
  const url=new URL(request.url), origin=request.headers.get('Origin');
  const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim());
  const headers={'Vary':'Origin','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'};
  if(origin && allowed.includes(origin))headers['Access-Control-Allow-Origin']=origin;
  const reply=response=>{const h=new Headers(response.headers);for(const [k,v]of Object.entries(headers))h.set(k,v);return new Response(response.body,{status:response.status,headers:h});};
  if(origin && !allowed.includes(origin))return reply(json({message:'来源不允许'},403));
  if(request.method==='OPTIONS')return reply(new Response(null,{status:204}));
  if(url.pathname==='/health' && request.method==='GET')return reply(json({ok:true,modelConfigured:Boolean(env.DEEPSEEK_API_KEY),deliveryConfigured:Boolean(env.FEISHU_WEBHOOK),collectionConfigured:Boolean(env.FEEDS),rssSource:env.FEEDS && env.RSS_SOURCE!=='legacy'?'cloudflare':'external'}));
  const admin=url.pathname.startsWith('/api/admin/');
  if(admin && (!env.ADMIN_TOKEN || request.headers.get('Authorization')!==`Bearer ${env.ADMIN_TOKEN}`))return reply(json({message:'未授权'},401));
  const collectorRoutes={'GET /feed.xml':'/feed','POST /api/admin/collect':'/collect','GET /api/admin/collection-status':'/status'};
  const collectorPath=collectorRoutes[`${request.method} ${url.pathname}`];
  if(collectorPath) {
    if(!env.FEEDS)return reply(json({message:'采集服务尚未配置'},503));
    try{return reply(await env.FEEDS.get(env.FEEDS.idFromName('aibase')).fetch(`https://internal${collectorPath}`,{method:request.method}));}
    catch{return reply(json({message:'采集服务暂时不可用'},503));}
  }
  const routes={'POST /api/chat':'/chat','GET /api/digests/today':'/digest','POST /api/admin/preview':'/preview','POST /api/admin/send':'/send','GET /api/admin/status':'/status'};
  const path=routes[`${request.method} ${url.pathname}`];
  if(!path)return reply(json({message:'接口不存在'},404));
  try {
    let body='';
    if(request.method==='POST') {
      const reader=request.body?.getReader();let size=0;const decoder=new TextDecoder();
      if(reader)while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>40000){await reader.cancel();throw new ServiceError('请求内容过长',413);}body+=decoder.decode(value,{stream:true});} body+=decoder.decode();
    }
    const stub=env.NEWS.get(env.NEWS.idFromName(dateKey(now)));
    const response=await stub.fetch(new Request(`https://internal${path}`,{method:request.method,headers:{'Content-Type':'application/json','X-Client-IP':request.headers.get('CF-Connecting-IP')||'local'},...(request.method==='POST'?{body:body||'{}'}:{})}));
    return reply(response);
  }catch(error){return reply(errorResponse(error));}
}
