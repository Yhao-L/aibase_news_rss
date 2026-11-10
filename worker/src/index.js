import template from './digest-prompt.txt';
import {NewsService,route,json,errorResponse} from './service.js';
import {dateKey,ServiceError} from './core.js';
export {FeedCollector} from './collector.js';

export class NewsCoordinator {
  constructor(ctx,env) {this.ctx=ctx;this.service=new NewsService(ctx.storage,env,template);}
  async fetch(request) {
    try {
      const path=new URL(request.url).pathname;
      // Each daily object expires its retained data after 30 days.
      if(!await this.ctx.storage.getAlarm())await this.ctx.storage.setAlarm(Date.now()+30*86400000);
      if(path==='/chat') {
        let body;try{body=await request.json();}catch{throw new ServiceError('请求不是有效 JSON',400);}
        return json(await this.service.chat(body,request.headers.get('X-Client-IP')));
      }
      if(path==='/preview')return json(await this.service.digest());
      if(path==='/send')return json(await this.service.send());
      if(path==='/status')return json({digest:await this.ctx.storage.get('digest')||null,delivery:await this.ctx.storage.get('delivery')||null,lastFailure:await this.ctx.storage.get('lastFailure')||null,generation:await this.ctx.storage.get('digestGeneration')||null});
      if(path==='/digest') {
        const digest=await this.ctx.storage.get('digest');
        return digest?json(digest):json({message:'今日日报尚未生成，可在对话中请求今日新闻'},404);
      }
      return json({message:'接口不存在'},404);
    } catch(error){if(new URL(request.url).pathname==='/send')await this.ctx.storage.put('lastFailure',{at:new Date().toISOString(),message:error instanceof ServiceError?error.message:'服务执行失败'});console.error('news_request_failed',{type:error.name,status:error.status||500});return errorResponse(error);}
  }
  async alarm(){await this.ctx.storage.deleteAll();}
}
export default {
  fetch(request,env) { return route(request,env); },
  async scheduled(event,env,ctx) {
    const task=(async()=>{
      if(event.cron==='30 3 * * *') {
        const response=await env.FEEDS.get(env.FEEDS.idFromName('aibase')).fetch('https://internal/collect',{method:'POST'});
        if(!response.ok)throw new Error(`Scheduled RSS collection failed (${response.status})`);
        console.log('rss_collection_started',{date:dateKey(event.scheduledTime)});
        return;
      }
      if(event.cron!=='0 4 * * *')throw new Error('Unexpected cron expression');
      const stub=env.NEWS.get(env.NEWS.idFromName(dateKey(event.scheduledTime)));
      const response=await stub.fetch('https://internal/send',{method:'POST'});
      if(!response.ok)throw new Error(`Scheduled news delivery failed (${response.status})`);
      console.log('news_delivery_completed',{date:dateKey(event.scheduledTime)});
    })();
    ctx.waitUntil(task);
  }
};
