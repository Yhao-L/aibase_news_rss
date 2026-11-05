// Adapted from the user's Coze card formatter, without Coze runtime dependencies.
export function buildCard(markdown) {
  const md = String(markdown || '').replace(/\r\n?/g,'\n').replace(/([^\n])\n(-{3,})/g,'$1\n\n$2').trim();
  const lines = md.split('\n');
  const heading = lines[0]?.match(/^(#{1,2})\s+(.*)$/);
  const title = heading ? heading[2].replace(/\*\*(.*?)\*\*/g,'$1').trim() : '每日AI资讯';
  let body = (heading ? lines.slice(1).join('\n') : md).trim();
  body = body.replace(/^#{1,6}\s+(.*)$/gm, (_,content) => {
    const clean = content.replace(/\*/g,'').trim();
    return /高优关注|要闻速览/.test(clean) ? `#### **${clean}**` : `**${clean}**`;
  }).replace(/^\*\*(高优关注|要闻速览)\*\*\s*$/gm,'#### **$1**')
    .replace(/(?<!\n\n)(摘要：|【推荐指数)/g,'\n\n$1');
  const parts = []; let buffer = '';
  for (const paragraph of body.split(/\n{2,}/).map(s=>s.trim()).filter(Boolean)) {
    if (paragraph.length > 3200) {
      if(buffer) parts.push(buffer); buffer='';
      // Code-point splitting avoids breaking surrogate pairs such as emoji.
      let part=''; for(const char of paragraph) {if(part.length+char.length>3200){parts.push(part);part='';} part+=char;} if(part)parts.push(part);
    } else if ((buffer ? buffer.length+2 : 0)+paragraph.length > 3200) {parts.push(buffer);buffer=paragraph;}
    else buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if(buffer) parts.push(buffer);
  return {schema:'2.0',config:{update_multi:true},header:{title:{tag:'plain_text',content:title||'每日AI资讯'},template:'blue'},body:{direction:'vertical',padding:'12px 12px 12px 12px',elements:(parts.length?parts:[' ']).map(content=>({tag:'markdown',content,text_align:'left'}))}};
}
export async function sendCard(env, md, fetcher=fetch) {
  if (!/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(env.FEISHU_WEBHOOK || '')) throw new Error('飞书 webhook 尚未配置');
  const body = JSON.stringify({msg_type:'interactive',card:buildCard(md)});
  if (new TextEncoder().encode(body).length > 28000) throw new Error('飞书卡片超出消息大小限制');
  const response = await fetcher(env.FEISHU_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error('飞书发送响应失败');
  const result = await response.json();
  if (result.code !== 0 && result.StatusCode !== 0) throw new Error('飞书拒绝了卡片消息');
}
