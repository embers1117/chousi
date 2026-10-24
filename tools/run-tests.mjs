// 一个不依赖 `node --test` 子进程的跑测器（某些受限沙箱里 spawn 会被拒）
// Node 18+ 均可；报告由 node:test 自己在进程退出时输出。
import { readdir } from 'node:fs/promises';

const dir = new URL('../tests/', import.meta.url);
const files = (await readdir(dir)).filter((f) => f.endsWith('.test.mjs')).sort();
if (!files.length) {
  console.error('没有找到测试文件');
  process.exit(1);
}
for (const f of files) {
  await import(new URL(f, dir).href);
}
