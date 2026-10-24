// tools/bundle.mjs —— 把整个应用打成单个 HTML 文件（双击即用，file:// 也能跑）
//
// 为什么需要它：浏览器在 file:// 下会以 CORS 为由拒绝加载 ES module，
// 所以 dist 版本把模块按依赖顺序包进一个 IIFE 里，零请求、零构建工具。
//
//   node tools/bundle.mjs  ->  dist/chousi.html
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const SRC = resolve(ROOT, 'src');
const ENTRY = 'app.js';

const read = (p) => readFile(p, 'utf8');

/** 依赖顺序（拓扑排序的结果，手工维护；extract/util 变化不用改这里） */
async function collect(entry) {
  const seen = new Map();
  const order = [];
  async function walk(file) {
    if (seen.has(file)) return;
    seen.set(file, true);
    const code = await read(resolve(SRC, file));
    const deps = [...code.matchAll(/^\s*import\s+\{[^}]*\}\s+from\s+['"]\.\/([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const d of deps) await walk(d);
    order.push({ file, code });
  }
  await walk(entry);
  return order;
}

/** ESM 片段 -> 普通函数体 + exports 赋值 */
function transform(code, file, exportsOut) {
  let out = code;

  // import { a, b } from './x.js';  ->  const { a, b } = __req('x.js');
  out = out.replace(/^\s*import\s+\{([^}]*)\}\s+from\s+['"]\.\/([^'"]+)['"];?/gm, (_, names, dep) => {
    const clean = names.split(',').map((s) => s.trim()).filter(Boolean).join(', ');
    return `const { ${clean} } = __req('${dep}');`;
  });

  // export async function f / export function f
  out = out.replace(/^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, (_, asy, name) => {
    exportsOut.push(name);
    return `${asy || ''}function ${name}`;
  });

  // export const / let / var / class
  out = out.replace(/^export\s+(const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => {
    exportsOut.push(name);
    return `${kind} ${name}`;
  });

  // export { a, b };
  out = out.replace(/^export\s*\{([^}]*)\}\s*;?/gm, (_, names) => {
    names.split(',').map((s) => s.trim()).filter(Boolean)
      .forEach((n) => exportsOut.push(n.split(/\s+as\s+/).pop().trim()));
    return '';
  });

  if (/^\s*export\s+/m.test(out)) {
    throw new Error(`${file} 里还有没处理的 export，请检查打包脚本`);
  }
  return out;
}

const order = await collect(ENTRY);
const parts = [];
for (const { file, code } of order) {
  const exp = [];
  const body = transform(code, file, exp);
  parts.push(
    `__defs[${JSON.stringify(file)}] = function (module, exports, __req) {\n` +
    body + '\n' +
    exp.map((n) => `  exports.${n} = ${n};`).join('\n') + '\n' +
    `};`
  );
}

const bundleJs = `(function () {
  'use strict';
  const __defs = {};
  const __cache = {};
  function __req(id) {
    id = String(id).replace(/^\\.\\//, '');
    if (__cache[id]) return __cache[id].exports;
    const def = __defs[id];
    if (!def) throw new Error('模块不存在：' + id);
    const mod = { exports: {} };
    __cache[id] = mod;
    def(mod, mod.exports, __req);
    return mod.exports;
  }
${parts.join('\n')}
  __req(${JSON.stringify(ENTRY)});
})();`;

// 语法自检：能编译通过才算打包成功
try {
  new Function(bundleJs); // eslint-disable-line no-new-func
} catch (err) {
  console.error('打包结果语法错误：', err.message);
  process.exit(1);
}

const html = await read(resolve(ROOT, 'index.html'));
const css = await read(resolve(SRC, 'styles.css'));

let out = html
  .replace(/<link rel="stylesheet" href="src\/styles\.css">/, `<style>\n${css}\n</style>`)
  .replace(/<script type="module" src="src\/app\.js"><\/script>/, () => `<script>\n${bundleJs}\n</script>`);

if (out === html) {
  console.error('没找到要替换的 link/script 标签，index.html 结构可能变了');
  process.exit(1);
}

out = out.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-bundled="1">');

await mkdir(resolve(ROOT, 'dist'), { recursive: true });
await writeFile(resolve(ROOT, 'dist/chousi.html'), out, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`✅ 已生成 dist/chousi.html（${kb(Buffer.byteLength(out))}，内联 ${order.length} 个模块 + CSS）`);
console.log('   双击即可打开，无需服务器。');
