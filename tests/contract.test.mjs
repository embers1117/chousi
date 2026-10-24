// 契约测试：app.js 里用到的每个 id / data-* 必须在 index.html 里真的存在，
// 关键 CSS 选择器必须在 styles.css 里真的存在。
// 这类错误浏览器只在运行时静默报 null，抛错之前很难发现，所以固化成测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(fileURLToPath(new URL(p, root)), 'utf8');

const html = await read('index.html');
const app = await read('src/app.js');
const css = await read('src/styles.css');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test('app.js 里 $(\'#id\') 引用的元素都存在于 index.html', () => {
  const used = new Set();
  for (const m of app.matchAll(/\$\$?\('#([A-Za-z0-9_-]+)/g)) used.add(m[1]);
  for (const m of app.matchAll(/getElementById\('([^']+)'\)/g)) used.add(m[1]);
  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], '这些 id 在 HTML 里找不到：' + missing.join(', '));
});

test('模板里的 data-field 覆盖了 app.js 用到的全部字段', () => {
  const inHtml = new Set([...html.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...app.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((f) => !inHtml.has(f));
  assert.deepEqual(missing, [], 'HTML 模板缺少字段：' + missing.join(', '));
  for (const must of ['title', 'due', 'dueText', 'place', 'people', 'notes', 'priority', 'category', 'deadline']) {
    assert.ok(inHtml.has(must), '模板缺少必备字段 ' + must);
  }
});

test('data-act 覆盖了 app.js 用到的全部动作', () => {
  const inHtml = new Set([...html.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...app.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((a) => !inHtml.has(a));
  assert.deepEqual(missing, [], 'HTML 模板缺少动作：' + missing.join(', '));
});

test('styles.css 关键选择器齐全', () => {
  const must = [
    '[hidden]', '[data-theme="dark"]', '.card', '.card[data-mode="saved"]',
    '.group-head', '.toast', '.dialog', '::backdrop', '.is-done', '.is-on',
    '.btn-primary', '.chip', '.inp', '.badge', '.card-source', 'mark',
  ];
  const missing = must.filter((sel) => !css.includes(sel));
  assert.deepEqual(missing, [], 'styles.css 缺少选择器：' + missing.join(', '));
});

test('index.html 不引用任何外网资源', () => {
  const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  // 只有 GitHub 链接允许出现在页面里
  const bad = remote.filter((u) => !/github\.com/.test(u));
  assert.deepEqual(bad, [], '出现了外链资源：' + bad.join(', '));
});

test('模板结构自洽：每个卡片必须有 title / due / place 输入框', () => {
  const tpl = html.slice(html.indexOf('<template id="tpl-card">'), html.indexOf('</template>'));
  for (const f of ['title', 'dueText', 'due', 'place', 'people', 'notes']) {
    assert.ok(tpl.includes(`data-field="${f}"`), `模板缺少 ${f} 输入框`);
  }
  assert.ok(tpl.includes('class="card"'), '模板根节点应是 .card');
});
