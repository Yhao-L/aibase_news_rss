import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleDigest} from '../src/digest.js';
import {EMPTY_DIGEST} from '../src/core.js';
import {buildCard,MAX_CARD_BYTES} from '../src/feishu.js';
const articles=Array.from({length:15},(_,i)=>({title:`模型发布 ${i+1}`,link:`https://news.aibase.com/zh/news/${i+1}`,content:'原始全文',published:Date.now()}));
const item=(id,score=9,extra={})=>({id:String(id),eligible:true,score,summary:'有用的摘要。',event_id:`事件 ${id}`,...extra});
const assemble=items=>assembleDigest(JSON.stringify({items}),articles);

test('malformed entries do not block valid news; use original titles and links',()=>{
 const result=assemble([null,[],item('unknown'),item(2,11),item(3,'9.0'),item(4,9,{summary:{bad:true}}),item(5,9,{eligible:'true'}),item(1,9.1,{title:'虚构标题',link:'https://evil.example',summary:'可用摘要'})]);
 assert.deepEqual(result.diagnostics.selectedIds,['1']);assert.equal(result.diagnostics.skipped.length,7);
 assert.ok(result.markdown.includes('[模型发布 1](https://news.aibase.com/zh/news/1)'));
 assert.ok(!result.markdown.includes('虚构标题'));assert.ok(!result.markdown.includes('evil.example'));
});
test('code orders and caps groups, keeps highest-scoring report of an event',()=>{
 const result=assemble([item(1,8.9,{event_id:'共享事件'}),item(2,9.8,{event_id:'共享事件'}),item(3,9.5),item(4,9.6),item(5,9.9),...Array.from({length:10},(_,i)=>item(i+6,8.5+i/20))]);
 assert.deepEqual(result.diagnostics.selectedIds.slice(0,3),['5','2','4']);
 assert.equal(result.diagnostics.selectedIds.length,9);
 assert.ok(!result.diagnostics.selectedIds.includes('1'));
 const [high,brief]=result.markdown.split('#### **要闻速览**');
 assert.equal([...high.matchAll(/推荐指数/g)].length,3);assert.equal([...brief.matchAll(/推荐指数/g)].length,6);
 assert.ok([...brief.matchAll(/【推荐指数：([\d.]+)⭐】/g)].every(m=>Number(m[1])>=8.5 && Number(m[1])<9.5));
});
test('score normalization does not promote entries across thresholds',()=>{
 const result=assemble([item(1,8.49),item(2,9.49),item(3,9.5)]);
 assert.deepEqual(result.diagnostics.selectedIds,['3','2']);
 assert.ok(result.markdown.includes('【推荐指数：9.4⭐】'));
});
test('summary length is soft and missing event grouping does not discard useful news',()=>{
 const result=assemble([item(1,9,{summary:'字'.repeat(150),event_id:undefined}),item(2,8.9,{summary:'简短摘要'}),item(3,9,{summary:'字'.repeat(601)})]);
 assert.deepEqual(result.diagnostics.selectedIds,['1','2']);
 assert.equal(result.diagnostics.warnings.length,3);assert.equal(result.diagnostics.skipped.length,1);
});
test('rendered text cannot inject arbitrary Markdown links or HTML',()=>{
 const source=[{...articles[0],title:'模型 [标题](https://evil.example) <img>'}];
 const {markdown}=assembleDigest(JSON.stringify({items:[item(1,9,{summary:'摘要\n#### 高优关注\n[点击](https://evil.example)<script>!'})]}),source);
 assert.ok(!markdown.includes('<script>'));assert.ok(!markdown.includes('<img>'));
 assert.ok(!markdown.includes('\n#### 高优关注'));
 assert.ok(markdown.includes('\\[点击\\]\\(https://evil.example\\)'));
});
test('known forbidden topic is removed individually',()=>{
 const source=[{...articles[0],title:'芯片发布'},{...articles[1],title:'模型在游戏开发评测中进步'},{...articles[2],title:'首款AI游戏陪伴Agent开启内测'},{...articles[3],title:'迪士尼携手Adobe开发专属AI模型'}];
 const result=assembleDigest(JSON.stringify({items:[item(1,10),item(2,9),item(3,9.9),item(4,9.9)]}),source);
 assert.deepEqual(result.diagnostics.selectedIds,['2']);
});
test('genuinely empty selection differs from malformed or missing decisions',()=>{
 assert.equal(assembleDigest('{"items":[{"id":"1","eligible":false}]}',[articles[0]]).markdown,EMPTY_DIGEST);
 assert.equal(assembleDigest(JSON.stringify({items:[item(1,8)]}),[articles[0]]).markdown,EMPTY_DIGEST);
 for(const raw of ['broken','{}','{"items":null}','{"items":[]}',JSON.stringify({items:[item(1,9,{summary:''})]})]) {
   assert.throws(()=>assembleDigest(raw,[articles[0]]));
 }
});
test('duplicate source IDs are only rendered once',()=>{
 const result=assemble([item(1,9),item(1,9.8),item(2,8.7)]);
 assert.deepEqual(result.diagnostics.selectedIds,['1','2']);
 assert.ok(result.diagnostics.skipped.some(s=>s.reason==='重复新闻 ID'));
});
test('large escaped text skips overflowing entries rather than blocking the card',()=>{
 const sources=articles.map(a=>({...a,title:'&'.repeat(300)}));
 const result=assembleDigest(JSON.stringify({items:Array.from({length:9},(_,i)=>item(i+1,i<3?9.8:9,{summary:'&'.repeat(600)}))}),sources);
 assert.ok(result.diagnostics.selectedIds.length>0 && result.diagnostics.selectedIds.length<9);
 const bytes=new TextEncoder().encode(JSON.stringify({msg_type:'interactive',card:buildCard(result.markdown)})).length;
 assert.ok(bytes<=MAX_CARD_BYTES);assert.ok(result.diagnostics.skipped.length>0);
});
