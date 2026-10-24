// tools/llm-proxy.mjs —— 给「AI 增强」模式用的本地转发小代理
//
// 为什么需要：浏览器直连 OpenAI / DeepSeek 等接口时，对方多半不放行 CORS，
// 前端只能拿到一个 Failed to fetch。这个脚本在本机起一个 30 行的转发器，
// 由它去替你请求上游，顺手补上 CORS 头。
//
// 用法（任选其一）：
//   1) node tools/llm-proxy.mjs
//      然后在界面「AI 设置」里把接口地址填成  http://127.0.0.1:8787/v1
//      （Key 依然在页面上填，代理不保存任何东西）
//   2) UPSTREAM=https://api.deepseek.com/v1 KEY=sk-xxx node tools/llm-proxy.mjs
//      这样页面上的 Key 可以随便填，真正生效的是环境变量里的 KEY
//
// 只监听 127.0.0.1，不对外网开放。按 Ctrl+C 停止。
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 8787;
const UPSTREAM = (process.env.UPSTREAM || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const ENV_KEY = process.env.KEY || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' }).end('只支持 POST');
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const target = UPSTREAM + (req.url || '').replace(/^\/v1/, '');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: ENV_KEY ? `Bearer ${ENV_KEY}` : (req.headers.authorization || ''),
  };

  console.log(`→ ${req.method} ${target}  (${body.length} bytes)`);
  try {
    const upstream = await fetch(target, { method: 'POST', headers, body });
    const text = await upstream.text();
    console.log(`← ${upstream.status} (${text.length} bytes)`);
    res.writeHead(upstream.status, {
      ...CORS,
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
    }).end(text);
  } catch (err) {
    console.error('上游请求失败：', err.message);
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' }).end(
      JSON.stringify({ error: { message: '代理转发失败：' + err.message } })
    );
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI 代理已启动： http://127.0.0.1:${PORT}/v1  →  ${UPSTREAM}`);
  console.log(ENV_KEY ? '已使用环境变量 KEY（页面上的 Key 可留空）' : '未设置环境变量 KEY，将透传页面填的 Key');
  console.log('把界面的「接口地址」填成上面这个地址即可。Ctrl+C 停止。');
});
