/**
 * wiring.test.mjs —— 接线检查：相对 import 路径、具名导入、HTML 引用的资源是否都存在
 *
 * CI 里原有的检查只看 manifest.json 点名的那几个文件，管不到下面这几类错误：
 *   · JS 之间的相对 import 写错了路径
 *   · `import { foo }` 里的 foo 在目标模块里根本不存在
 *     （平时靠打包器报错，而这个项目零构建，没有打包器兜底）
 *   · HTML 里的 <script src> / <link href> 指向不存在的文件
 *
 * 这几类错误会让扩展在 chrome://extensions 里**直接加载失败**，或者跑到一半才炸。
 *
 * 纯 Node，零依赖：node test/wiring.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------ 工具函数 */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = p => relative(ROOT, p).replace(/\\/g, '/');

/** 把一个模块里所有具名导出的名字抓出来（正则足够，本项目没有花哨的导出语法） */
function exportNames(source) {
  const names = new Set();

  const decl = /^[ \t]*export[ \t]+(?:async[ \t]+)?(?:const|let|var|function|class)[ \t]+([A-Za-z_$][\w$]*)/gm;
  for (const m of source.matchAll(decl)) names.add(m[1]);

  const list = /^[ \t]*export[ \t]*\{([^}]*)\}/gm;
  for (const m of source.matchAll(list)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (t) names.add(t.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

/** 从 import 子句里取出具名导入（忽略 default 与 namespace 形式） */
function namedImports(clause) {
  const m = /\{([^}]*)\}/.exec(clause);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

const IMPORT_RE = /^[ \t]*import[ \t]+([^'"]*?)[ \t]*from[ \t]*['"]([^'"]+)['"]/gm;
const HTML_ATTR_RE = /\b(?:src|href)[ \t]*=[ \t]*["']([^"']+)["']/g;

/* ---------------------------------------------------------------- 用例 */

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.error(`  \u2717 ${name}`);
    console.error(`      ${(e && e.message) || e}`);
    failed++;
  }
}

const files = walk(ROOT);
const jsFiles = files.filter(f => /\.(js|mjs)$/.test(f));
const htmlFiles = files.filter(f => f.endsWith('.html'));

console.log('\n接线检查（import / 具名导入 / HTML 资源）\n');

test(`所有相对 import 都指向存在的文件（共 ${jsFiles.length} 个 JS）`, () => {
  const problems = [];
  let checked = 0;

  for (const file of jsFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[2];
      if (!spec.startsWith('.')) continue;      // 只关心相对路径
      checked++;
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) {
        problems.push(`${rel(file)} → '${spec}'（解析为 ${rel(target)}，不存在）`);
      }
    }
  }

  assert.equal(problems.length, 0, `有 ${problems.length} 个 import 指向不存在的文件：\n      ${problems.join('\n      ')}`);
  console.log(`      [数据] 实际检查了 ${checked} 条相对 import`);
});

test('所有具名导入在目标模块里确实有导出', () => {
  const problems = [];
  let checked = 0;

  // 先把每个 JS 文件的导出集合算出来
  const exportsOf = new Map();
  for (const file of jsFiles) {
    exportsOf.set(resolve(file), exportNames(readFileSync(file, 'utf8')));
  }

  for (const file of jsFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const clause = m[1];
      const spec = m[2];
      if (!spec.startsWith('.')) continue;

      const target = resolve(dirname(file), spec);
      const available = exportsOf.get(target);
      if (!available) continue;   // 目标不是本仓库的 JS，交给上一条用例管

      for (const name of namedImports(clause)) {
        checked++;
        if (!available.has(name)) {
          problems.push(`${rel(file)} 导入了 { ${name} }，但 ${rel(target)} 没有导出它`);
        }
      }
    }
  }

  assert.equal(problems.length, 0, `有 ${problems.length} 个具名导入对不上：\n      ${problems.join('\n      ')}`);
  console.log(`      [数据] 实际核对了 ${checked} 个具名导入`);
});

test(`HTML 里的 src / href 都指向存在的文件（共 ${htmlFiles.length} 个页面）`, () => {
  const problems = [];
  let checked = 0;

  for (const file of htmlFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(HTML_ATTR_RE)) {
      const value = m[1].trim();
      // 跳过外链、锚点、内联数据等
      if (!value || /^(https?:|data:|mailto:|#|\/\/|chrome-extension:)/i.test(value)) continue;
      checked++;
      const target = resolve(dirname(file), value.split(/[?#]/)[0]);
      if (!existsSync(target)) {
        problems.push(`${rel(file)} 引用了 '${value}'（不存在）`);
      }
    }
  }

  assert.equal(problems.length, 0, `有 ${problems.length} 个资源引用不存在的文件：\n      ${problems.join('\n      ')}`);
  console.log(`      [数据] 实际检查了 ${checked} 条 HTML 资源引用`);
});

test('clean.js / popup.js / options.js 只 import 共享模块里真实存在的符号', () => {
  // 这几条用例和上面第二条重叠，但这里额外确认「页面确实引了 shared.js」
  // —— 万一某个页面漏了 import，上面第二条会因为没得检查而静默通过。
  const sharedPath = resolve(ROOT, 'src/shared.js');
  const sharedExports = exportNames(readFileSync(sharedPath, 'utf8'));

  const pages = ['clean/clean.js', 'options/options.js', 'popup/popup.js'];
  for (const page of pages) {
    const src = readFileSync(join(ROOT, page), 'utf8');
    assert.match(src, /from\s+['"]\.\.\/src\/shared\.js['"]/, `${page} 应该从 ../src/shared.js 导入`);
  }

  assert.ok(sharedExports.size > 10, `src/shared.js 的导出数量看起来不对：${sharedExports.size}`);
  console.log(`      [数据] src/shared.js 共导出 ${sharedExports.size} 个符号`);
});

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
