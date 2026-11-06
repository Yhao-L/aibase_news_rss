// Usage: node --env-file=.dev.vars scripts/smoke.mjs [base-url] [--send]
// --send sends a real daily news card; omit for preview-only checks.
const base=process.argv.find((value,index)=>index>1 && /^https?:/.test(value))||'http://localhost:8787';
const headers={'Content-Type':'application/json',Authorization:`Bearer ${process.env.ADMIN_TOKEN||''}`};
async function request(path,body) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(180000)});
  const result=await response.json();
  if(!response.ok)throw new Error(`${path}: ${response.status} ${result.message||'failed'}`);
  return result;
}
try {
  const health=await request('/health');console.log('Health:',health);
  if(!health.modelConfigured)throw new Error('Configure DEEPSEEK_API_KEY first');
  const digest=await request('/api/admin/preview',{});console.log('Digest:',{date:digest.date,articleCount:digest.articleCount,characters:digest.markdown.length});
  const reply=await request('/api/chat',{message:'请解释高优关注中第一条新闻的意义；如果没有新闻请直接说明。',history:[{role:'user',content:'今日AI新闻'},{role:'assistant',content:digest.markdown}]});
  console.log('Follow-up:',{characters:reply.content.length});
  if(process.argv.includes('--send'))console.log('Delivery:',await request('/api/admin/send',{}));
  else console.log('Preview only; no Feishu daily card sent.');
} catch(error) {console.error(error.message);process.exitCode=1;}
