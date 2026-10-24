// src/llm.js —— 可选的大模型增强（OpenAI 兼容接口）
//
// 设计原则：
//   1) 默认不联网。只有用户自己打开 AI 模式、自己填 Key 才会调用。
//   2) 完全兼容 OpenAI /chat/completions 协议，DeepSeek / Moonshot 等都能直接用。
//   3) 任何失败都抛错，由调用方决定是否回落到规则引擎。
//   4) 浏览器直连第三方接口可能被 CORS 拦住 —— 仓库自带 tools/llm-proxy.mjs 兜底。

import { toLocalInput } from './util.js';

export const PROVIDERS = {
  deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { label: 'Moonshot', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  custom: { label: '自定义', base: '', model: '' },
};

const SYSTEM_PROMPT = `你是一个待办抽取引擎。用户会给你一段中文长文本（通知、群聊、邮件、会议纪要等）。
你要从中抽出所有「需要有人去做的事」，输出 JSON。

严格要求：
1. 只输出 JSON，不要 markdown 代码块，不要解释。
2. 顶层是 {"items": [...]}，每个 item 的字段：
   - title: 待办标题，动宾结构，不超过 30 字，不要包含时间和地点
   - due: 本地时间 "YYYY-MM-DDTHH:mm"；只有日期就写 "YYYY-MM-DD"；实在没有给 null
   - dueText: 原文里的时间表述原文，如 "本周五上午10点前"；没有给 ""
   - deadline: 布尔，"之前/截止/前"这类硬期限填 true
   - precision: "minute" | "day" | "month" | "none"
   - place: 地点或线上会议方式；没有给 ""
   - people: 相关人姓名的字符串数组
   - notes: 备注，写要带的东西、要求、风险、费用等，用 "；" 分隔
   - priority: "high" | "normal" | "low"
   - category: "work" | "study" | "life" | "health" | "money" | "social" | "other"
3. 一句话里有多件事就拆成多个 item；重复描述同一件事要合并。
4. 相对时间必须换算成绝对日期，依据下面给出的「当前时间」。
5. 不要把纯背景信息、寒暄、落款当待办。
6. 没有时间也要抽取，due 给 null。`;

function buildUserPrompt(text, now) {
  const wd = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} 周${wd}`;
  return `当前时间：${stamp}\n\n待抽取文本：\n"""\n${text}\n"""`;
}

function endpoint(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('还没有填写接口地址');
  if (/\/chat\/completions$/.test(b)) return b;
  return `${b}/chat/completions`;
}

function pickJSON(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('模型没有返回 JSON');
  return JSON.parse(s.slice(start, end + 1));
}

function normDate(v) {
  if (!v) return { due: null, precision: 'none' };
  const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return { due: null, precision: 'none' };
  const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  if (Number.isNaN(d.getTime())) return { due: null, precision: 'none' };
  return { due: toLocalInput(d), precision: m[4] ? 'minute' : 'day' };
}

export function normalizeAIItems(payload) {
  const arr = Array.isArray(payload) ? payload : (payload && payload.items) || [];
  return arr.map((it) => {
    const { due, precision } = normDate(it.due);
    const title = String(it.title || '').trim();
    if (!title) return null;
    const ppl = Array.isArray(it.people)
      ? it.people.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : String(it.people || '').split(/[,，、;；\s]+/).filter(Boolean).slice(0, 8);
    return {
      title,
      due,
      dueEnd: null,
      dueText: String(it.dueText || '').trim(),
      deadline: !!it.deadline,
      precision: it.precision && ['minute', 'day', 'month', 'none'].includes(it.precision) ? it.precision : precision,
      place: String(it.place || '').trim(),
      people: ppl,
      notes: String(it.notes || '').trim(),
      priority: ['high', 'normal', 'low'].includes(it.priority) ? it.priority : 'normal',
      category: ['work', 'study', 'life', 'health', 'money', 'social', 'other'].includes(it.category) ? it.category : 'other',
      confidence: 0.9,
      weak: false,
      source: { text: '', marks: [] },
    };
  }).filter(Boolean);
}

/** 调用大模型抽取。失败抛 Error（消息可直接展示给用户） */
export async function extractWithAI(text, cfg, opts = {}) {
  const base = cfg.base || (PROVIDERS[cfg.provider] || {}).base;
  const model = cfg.model || (PROVIDERS[cfg.provider] || {}).model;
  if (!cfg.key) throw new Error('还没有填写 API Key');
  if (!model) throw new Error('还没有填写模型名');

  const url = endpoint(base);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 45000);
  if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(text, now) },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new Error('请求超时（45 秒）。文本太长可以分段试试。');
    throw new Error(`连不上接口：${err.message}。\n如果是浏览器 CORS 限制，先运行 npm run proxy 再把接口地址改成 http://127.0.0.1:8787/v1`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status}：${body.slice(0, 200) || res.statusText}`);
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('接口没有返回内容');
  const items = normalizeAIItems(pickJSON(content));
  if (!items.length) throw new Error('模型没有抽到待办');
  return items;
}

export async function testAI(cfg) {
  const items = await extractWithAI('明天下午3点在会议室开个会，记得带电脑。', cfg, { timeoutMs: 30000 });
  return items[0];
}
