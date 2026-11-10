// The model supplies decisions, never the final links or presentation.
// Recovery accepts independently valid objects, never repairs malformed field values.
import {buildCard,MAX_CARD_BYTES} from './feishu.js';
export const sourceId = article => article.link.match(/\/news\/(\d+)$/)?.[1];
const forbiddenTitle = /融资|投资|并购|战略合作|携手|伦理|监管|安全|风险|漏洞|提权|攻防|机器人|芯片|算力|GPU|自动驾驶|智能驾驶|车企|游戏陪伴|游戏陪玩|游戏搭子|体育|娱乐/i;
const sourceLink = /^https:\/\/news\.aibase\.com\/(?:zh\/)?news\/\d+$/;
const plain = value => value.replace(/\s+/gu,' ').trim();
// Treat source titles and generated summaries as text, not arbitrary Markdown/HTML.
const escapeText = value => value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_\[\]()!#|~]/g,'\\$&');
function failure(message,diagnostics) {
  const error=new Error(message);error.name='DigestError';error.status=502;error.diagnostics=diagnostics;return error;
}
export function assembleDigest(raw,articles) {
  const diagnostics={format:'json-v1',inputCount:articles.length,returnedCount:0,selectedIds:[],skipped:[],filtered:[],warnings:[],missingIds:[],parseErrors:[]};
  let data;
  try {data=JSON.parse(raw);} catch {
    // Only recover the documented flat items envelope. With intact object boundaries,
    // a missing quote in one field need not destroy all following items. Quotes in
    // valid JSON summary strings are escaped, so they cannot match the next id key.
    const envelope=raw.match(/^\s*\{\s*"items"\s*:\s*\[([\s\S]*)\]\s*\}\s*$/);
    if(!envelope)throw failure('日报 JSON 无法解析，未发送',diagnostics);
    const chunks=envelope[1].split(/(?<=\})\s*,\s*(?=\{\s*"id"\s*:)/u);
    const items=chunks.map((chunk,index)=>{
      try{return JSON.parse(chunk);}catch{diagnostics.parseErrors.push(index);return null;}
    });
    if(items.every(item=>item===null))throw failure('日报 JSON 无法解析，未发送',diagnostics);
    diagnostics.warnings.push({reason:'整批 JSON 损坏，按完整条目独立解析；未修补损坏字段'});
    data={items};
  }
  if(!data || !Array.isArray(data.items))throw failure('日报 JSON 缺少 items 数组，未发送',diagnostics);
  diagnostics.returnedCount=data.items.length;
  const sources=new Map(articles.map(a=>[sourceId(a),a]));
  const decisions=new Set(), candidates=[];
  data.items.forEach((item,index)=>{
    const id=typeof item?.id==='string'?item.id:null;
    const skip=reason=>diagnostics.skipped.push({index,id,reason});
    if(diagnostics.parseErrors.includes(index))return skip('条目 JSON 语法错误');
    if(!item || typeof item!=='object' || Array.isArray(item))return skip('条目不是对象');
    const article=sources.get(id);
    if(!article || !sourceLink.test(article.link) || typeof article.title!=='string' || !article.title.trim())return skip('未知新闻 ID 或原始来源无效');
    if(decisions.has(id))return skip('重复新闻 ID');
    if(typeof item.eligible!=='boolean')return skip('eligible 必须为布尔值');
    const filtered=reason=>{decisions.add(id);diagnostics.filtered.push({id,reason});};
    if(!item.eligible)return filtered('模型排除');
    if(forbiddenTitle.test(article.title))return filtered('原始标题命中禁止题材');
    if(typeof item.score!=='number' || !Number.isFinite(item.score) || item.score<0 || item.score>10)return skip('评分不是 0–10 范围的数字');
    // Never promote an item across the 8.5 or 9.5 threshold by rounding up.
    const score=Math.floor(item.score*10+1e-8)/10;
    if(score<8.5)return filtered('评分低于 8.5');
    if(typeof item.summary!=='string' || !item.summary.trim())return skip('缺少有效摘要');
    const summary=plain(item.summary), length=[...summary].length;
    // Length preference is soft; a generous upper bound protects the card payload.
    if(length>600 || [...article.title].length>300)return skip('条目过长，无法安全装入卡片');
    if(length<80 || length>120)diagnostics.warnings.push({id,reason:'摘要偏离建议的 80–120 字符',length});
    const eventId=typeof item.event_id==='string'?item.event_id.trim().normalize('NFKC').toLowerCase():'';
    if(!eventId)diagnostics.warnings.push({id,reason:'缺少事件分组，只按新闻 ID 去重'});
    decisions.add(id);
    candidates.push({id,eventId,score,summary,article});
  });
  diagnostics.missingIds=[...sources.keys()].filter(id=>!decisions.has(id));
  candidates.sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id));
  const events=new Set(),high=[],brief=[];
  const render=items=>items.map(({article,summary,score})=>`**[${escapeText(plain(article.title))}](${article.link})**\n摘要：${escapeText(summary)}\n【推荐指数：${score.toFixed(1)}⭐】\n\n---`).join('\n\n');
  const renderDigest=()=>`## **每日AI资讯**\n\n---\n\n#### **高优关注**\n\n${high.length?render(high):'今日无高优关注新闻\n\n---'}\n\n#### **要闻速览**\n\n${brief.length?render(brief):'今日无要闻速览\n\n---'}`;
  for(const item of candidates) {
    if(item.eventId && events.has(item.eventId)){diagnostics.filtered.push({id:item.id,reason:'重复事件'});continue;}
    const group=item.score>=9.5?high:brief, limit=item.score>=9.5?3:6;
    if(group.length>=limit){diagnostics.filtered.push({id:item.id,reason:'超过分组条数上限'});continue;}
    group.push(item);
    const cardBytes=new TextEncoder().encode(JSON.stringify({msg_type:'interactive',card:buildCard(renderDigest())})).length;
    if(cardBytes>MAX_CARD_BYTES){group.pop();diagnostics.skipped.push({id:item.id,reason:'加入后卡片超过大小限制'});continue;}
    if(item.eventId)events.add(item.eventId);
  }
  diagnostics.selectedIds=[...high,...brief].map(item=>item.id);
  if(!diagnostics.selectedIds.length && (diagnostics.skipped.length || diagnostics.missingIds.length)) {
    throw failure('没有可组装的有效新闻条目，不能将处理失败标记为无新闻',diagnostics);
  }
  return {markdown:renderDigest(),diagnostics};
}
