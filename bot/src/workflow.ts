import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { CONFIG } from './config';
import { AgentPreferences } from './claude/store';

export function planTask(prompt: string, prefs: AgentPreferences) {
  // Slash commands bypass this path. Explicit task constraints always win.
  const noPublish = /(?:不要|不必|先不|不用|禁止).{0,6}(?:发布|发文|发文章)|只(?:回答|回复|聊天|查询|查看|读|做测试)|只读(?:测试|集成测试)|(?:查询|汇报|查看).{0,10}(?:状态|进度|余额)|^(?:你好|嗨|谢谢)[！!。\s]*$/i.test(prompt);
  const research = /深度|深入|复杂|研究|调研|比较|评测|排查|修复|research|investigate/i.test(prompt);
  const publish = !noPublish;
  const upgrade = prefs.modelRouting === 'auto' && (publish || research);
  return {publish, model: upgrade ? CONFIG.RESEARCH_MODEL : prefs.codexModel,
    effort: upgrade ? 'medium' : prefs.reasoningEffort,
    reason: upgrade ? publish ? '内容三件套自动升档' : '复杂研究自动升档' : '日常任务'};
}

export async function checkDuplicate(prompt: string, jobId: string, signal?: AbortSignal) {
  const urls = [...prompt.matchAll(/https?:\/\/[^\s，。)）]+/g)].map(m=>m[0]).slice(0,5);
  const entity = prompt.split('\n').find(line=>line.trim())?.slice(0,100) || '微信内容';
  const args = ['-c', 'set -a; source .env; set +a; exec node .agents/skills/blog-publisher/check-duplicate.cjs "$@"',
    'heinu1-dedup', ...urls, entity];
  const result = await new Promise<{code:number|null;output:string}>((resolve,reject)=>{
    const p=spawn('/bin/bash',args,{cwd:CONFIG.BLOG_WORKSPACE,stdio:['ignore','pipe','pipe'],signal});
    let output='';
    p.stdout.on('data',d=>output+=d.toString()); p.stderr.on('data',d=>output+=d.toString());
    p.on('error',reject); p.on('close',code=>resolve({code,output}));
  });
  const dir=path.join(CONFIG.DATA_DIR,'jobs',jobId);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,'duplicate-check.json');
  fs.writeFileSync(file,JSON.stringify({...result,checkedAt:new Date().toISOString()},null,2),{mode:0o600});
  if (![0,1].includes(result.code ?? -1) || /⚠️\s*公众号账本没查成|source:.*No such file/i.test(result.output)) {
    throw new Error('发布前查重未完成；已保留任务，稍后重试');
  }
  return {file, duplicate:result.code===1};
}

export function publicationInstruction(jobId: string, check: {file:string;duplicate:boolean}) {
  return `\n\n[机主已授权的默认内容三件套，任务 ${jobId}]
本条消息是内容素材，默认进入 KB、写双语文章、生成与具体内容匹配的 banner、发布 Blog 并创建微信公众号草稿。原始素材已由机器人在写作前入 KB。
发布仓库：${CONFIG.BLOG_WORKSPACE}。先读该仓库 AGENTS.md，以及 .agents/skills/blog-publisher/SKILL.md、banner-creator/SKILL.md、seo-geo/SKILL.md，严格按流程执行。
机器人已运行写作前查重，结果在 ${check.file}。${check.duplicate ? '存在旧记录：先核对旧文章、公众号草稿、发布账本和知识库，只补缺失步骤，复用原 slug 和已有 media_id，不另写重复文章。仅有 KB 素材而尚无文章时，继续完成该素材的原始写作流程，不能把已入库误判为已发布。' : '查重未发现旧记录；写作前仍以一手源 URL 和精确实体名补查，确认之后才写。'}
历史失败重试必须先核对现状，只补未完成步骤。已经成功的部署、草稿、KB 记录不能盲目重建。Banner 必须来自对应文章主题；已有匹配的合格 banner 可复用。
公众号“发布”按既有 skill 创建草稿，不擅自群发。验证 Blog URL、列表、图片和公众号记录；补齐语义索引与发布账本。
完成后向用户汇报三件套，并在末尾另加机器校验块（本块随后会隐藏）：
\`\`\`publication-result
{"slug":"final-english-slug","blogUrl":"https://blog.mushroom.cv/blog/final-english-slug/","mediaId":"实际已创建或复用的公众号 media_id"}
\`\`\`
若任何一步失败，明确失败，不填写虚假成功结果。`;
}

export async function verifyPublication(text: string) {
  const match = [...text.matchAll(/```publication-result\s*([\s\S]*?)```/g)].pop();
  if (!match) throw new Error('缺少可核验的三件套发布结果');
  const data = JSON.parse(match[1]);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug)) throw new Error('发布结果 slug 无效');
  const url=`https://blog.mushroom.cv/blog/${data.slug}/`;
  if (data.blogUrl!==url) throw new Error('Blog URL 与最终 slug 不符');
  const root=CONFIG.BLOG_WORKSPACE;
  const md=path.join(root,'src/content/blog',data.slug+'.md');
  const markdown=fs.readFileSync(md,'utf8');
  const hero=markdown.match(/^heroImage:\s*["']?([^"'\r\n]+)/m)?.[1]?.trim();
  if (!hero || !fs.existsSync(path.resolve(path.dirname(md),hero))) throw new Error('文章 banner 缺失');
  const record=JSON.parse(fs.readFileSync(path.join(root,'pipeline/m2/output',data.slug+'.json'),'utf8'));
  if (!data.mediaId || (record.mediaId ?? record.media_id)!==data.mediaId) throw new Error('公众号草稿记录未核验');
  const res=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(15_000)});
  if (!res.ok) throw new Error(`Blog 未上线：HTTP ${res.status}`);
  return {slug:data.slug,blogUrl:url,mediaId:data.mediaId,banner:hero};
}

export function stripPublication(text:string) {
  return text.replace(/```publication-result[\s\S]*?(?:```|$)/g,'').trim();
}
