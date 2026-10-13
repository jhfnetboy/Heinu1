import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { CONFIG } from './config';
import { AgentPreferences } from './claude/store';

export class WorkflowBlockedError extends Error {}

export function duplicateFailure(code: number | null, output: string): Error {
  const errcode = output.match(/"?errcode"?\s*:\s*(\d+)/)?.[1]
    ?? output.match(/(?:draft|freepublish):\s*(\d+)/)?.[1];
  if (errcode === '40164' || /invalid ip .*not in whitelist/i.test(output)) {
    const ip = output.match(/invalid ip\s+([\d.]+)/i)?.[1] || '当前公网 IP';
    return new WorkflowBlockedError(`公众号 IP 白名单拒绝（40164）：${ip} 不在白名单。请在公众号后台「设置与开发 → 基本配置 → IP 白名单」添加该 IP，保留已有条目，之后发 /retry all。已暂停自动重试。`);
  }
  if (['40013', '40125', '48001'].includes(errcode || '') || /缺少 WECHAT_APP_ID|无法加载微信客户端|source:.*No such file/i.test(output)) {
    return new WorkflowBlockedError(`公众号查重配置或权限未就绪${errcode ? `（${errcode}）` : ''}；需要修复配置后发 /retry all，已暂停自动重试。`);
  }
  const detail = (output.split('\n').find(line=>/⚠️|❌|error|failed/i.test(line)) || output.trim().split('\n').pop() || `退出码 ${code}`)
    .replace(/((?:access_token|appid|secret)["']?\s*[=:]\s*["']?)[^\s&"',}]+/gi, '$1[redacted]').slice(0,500);
  return new Error(`发布前查重未完成：${detail}；已保留任务，稍后重试`);
}

export function planTask(prompt: string, prefs: AgentPreferences) {
  // Slash commands bypass this path. Explicit task constraints always win.
  const source = /https?:\/\/|\[(?:图片|文件|视频):/i.test(prompt);
  const routine = !source && /^(?:(?:你|机器人|现在|当前).{0,15}(?:什么|哪个|哪种).{0,6}(?:模型|后端|工作区)|(?:帮我|请)?(?:切换|设置|修改|重启|停止).{0,15}(?:机器人|默认模型|后端|服务|工作区)|(?:帮我|请)?修复.{0,10}(?:机器人|服务))/i.test(prompt.trim());
  const maintenance = !source && /(?:检查|查看|排查|修复|补一下|补齐|重试|报错|失败|为啥|为什么).{0,25}(?:历史(?:失败的)?消息|失败任务|失败的处理|微信消息|微信机器人|机器人)|(?:历史(?:失败的)?消息|失败任务|微信消息|微信机器人|机器人).{0,25}(?:检查|排查|修复|重试|失败|报错)/i.test(prompt);
  const noPublish = routine || maintenance || /(?:不要|不必|先不|不用|禁止).{0,6}(?:发布|发文|发文章)|只(?:回答|回复|聊天|查询|查看|读|做测试)|只读(?:测试|集成测试)|(?:查询|汇报|查看).{0,10}(?:状态|进度|余额)|^(?:你好|嗨|谢谢|hi|hello|thanks)[！!。\s]*$/i.test(prompt);
  const research = maintenance || /深度|深入|复杂|研究|调研|比较|评测|排查|修复|research|investigate/i.test(prompt);
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
    const state = result.output.match(/```dedup-result\s*([\s\S]*?)```/)?.[1];
    if (state) {
      const data = JSON.parse(state);
      // Owner explicitly requires KB/Blog to proceed while WeChat is blocked.
      // All available local ledgers must actually have been read first.
      if (data.localLedgersRead === true && /40164/.test(data.wechatError || '')) {
        return {file,duplicate:!!data.duplicate,wechatError:duplicateFailure(2,data.wechatError).message};
      }
    }
    throw duplicateFailure(result.code, result.output);
  }
  return {file, duplicate:result.code===1};
}

export function publicationInstruction(jobId: string, check: {file:string;duplicate:boolean;wechatError?:string}) {
  return `\n\n[机主已授权的默认内容三件套，任务 ${jobId}]
本条消息是内容素材，默认进入 KB、写双语文章、生成与具体内容匹配的 banner、发布 Blog 并创建微信公众号草稿。原始素材已由机器人在写作前入 KB。
发布仓库：${CONFIG.BLOG_WORKSPACE}。先读该仓库 AGENTS.md，以及 .agents/skills/blog-publisher/SKILL.md、banner-creator/SKILL.md、seo-geo/SKILL.md，严格按流程执行。
机器人已运行写作前查重，结果在 ${check.file}。${check.duplicate ? '存在旧记录：先核对旧文章、公众号草稿、发布账本和知识库，只补缺失步骤，复用原 slug 和已有 media_id，不另写重复文章。仅有 KB 素材而尚无文章时，继续完成该素材的原始写作流程，不能把已入库误判为已发布。' : '查重未发现旧记录；写作前仍以一手源 URL 和精确实体名补查，确认之后才写。'}
历史失败重试必须先核对现状，只补未完成步骤。已经成功的部署、草稿、KB 记录不能盲目重建。Banner 必须来自对应文章主题；已有匹配的合格 banner 可复用。
${check.wechatError ? `机主再次明确要求三个渠道分别推进：本地 Blog、M2 发布记录和 KB 已查重，但公众号远程查询被白名单拒绝。错误：${check.wechatError}。这不阻止 KB 和 Blog：先核对本地记录，完成 Blog 部署和线上验证，再对缺失的公众号草稿实际尝试一次 M2。公众号失败也必须输出已验证的 Blog URL；mediaId 留空并填写真实 wechatError，不能中止 Blog、虚构草稿或只回复白名单错误。重试已完成的文章只补公众号。` : ''}
公众号“发布”按既有 skill 创建草稿，不擅自群发。验证 Blog URL、列表、图片和公众号记录；补齐语义索引与发布账本。
完成后向用户汇报三件套，并在末尾另加机器校验块（本块随后会隐藏）：
\`\`\`publication-result
{"slug":"final-english-slug","blogUrl":"https://blog.mushroom.cv/blog/final-english-slug/","mediaId":"实际已创建或复用的公众号 media_id，失败时空字符串","wechatError":"仅公众号失败时填写真实原因"}
\`\`\`
微信回复第一句必须回答「是不是发布了博客？」并给出是/否和完整链接；分别说明 KB 和公众号草稿状态。若任何一步失败，明确失败，不填写虚假成功结果。`;
}

export interface PublicationProof {slug:string;blogUrl:string;mediaId:string;banner:string;wechatError?:string;}
export async function verifyPublication(text: string): Promise<PublicationProof> {
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
  const res=await fetch(url,{signal:AbortSignal.timeout(15_000)});
  if (!res.ok) throw new Error(`Blog 未上线：HTTP ${res.status}`);
  const html=await res.text();
  const og=html.match(/<meta\b[^>]*(?:property|name)=["']og:image["'][^>]*>/i)?.[0] ?? '';
  const stem=path.basename(hero,path.extname(hero));
  if (!og.includes(stem)) throw new Error('线上 Blog 封面与最终文章 banner 不符');
  if (data.mediaId) {
    const record=JSON.parse(fs.readFileSync(path.join(root,'pipeline/m2/output',data.slug+'.json'),'utf8'));
    if ((record.mediaId ?? record.media_id)!==data.mediaId) throw new Error('公众号草稿记录未核验');
  } else if (!data.wechatError) throw new Error('公众号草稿缺失且没有失败原因');
  return {slug:data.slug,blogUrl:url,mediaId:data.mediaId || '',banner:hero,wechatError:data.mediaId ? '' : String(data.wechatError)};
}

export function publicationReply(kbConfirmed:boolean, proof?:{blogUrl?:string;mediaId?:string;wechatError?:string}) {
  return (proof?.blogUrl ? `是不是发布了博客？是，已核验上线。\n✅ Blog：${proof.blogUrl}` : '是不是发布了博客？尚未核验发布成功。\n❌ Blog：尚无可核验的上线链接。')
    + `\n${kbConfirmed ? '✅ KB：原始素材已入库。' : '❌ KB：尚未确认入库。'}`
    + (proof?.mediaId ? `\n✅ 公众号草稿：已创建（media_id: ${proof.mediaId}）` : `\n❌ 公众号草稿：未确认创建${proof?.wechatError ? `；${proof.wechatError}` : '。'}`);
}

export function stripPublication(text:string) {
  return text.replace(/```publication-result[\s\S]*?(?:```|$)/g,'').trim();
}
