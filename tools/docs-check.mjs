#!/usr/bin/env node
/**
 * docs-check：文档一致性门禁（CI docs-check 强制项）
 *
 * 检查项（任一失败 → 非零退出，并逐条打印原因）：
 *   a. docs/ 下所有 .md 的相对链接/引用路径真实存在；
 *   b. docs/STATUS.md 的 based_on 是当前 git HEAD 的祖先，且 HEAD 领先提交数 ≤ 10；
 *   c. docs/DECISIONS.md 中 D 编号无重复；
 *   d. docs/STATUS.md 与 docs/DECISIONS.md 不得有 ≥ 40 字的相同行（防复制正文）。
 *
 * 无第三方依赖，Node >= 18。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');
const statusPath = path.join(docsDir, 'STATUS.md');
const decisionsPath = path.join(docsDir, 'DECISIONS.md');

/** 引用路径识别：带这些后缀的行内代码/纯路径视为仓库内引用 */
const PATH_EXT_RE = /\.(md|mdx|markdown|mjs|cjs|js|mts|cts|ts|tsx|jsx|json|ya?ml|sql|sh|bash|txt|html|css|svg)$/i;
/** 仓库根相对前缀（文档惯用的根相对引用写法） */
const ROOT_PREFIX_RE = /^(docs|src|tests|spec|tools|\.github)\//;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

const failures = [];
const notes = [];

function fail(check, msg) {
  failures.push(`[${check}] ${msg}`);
}

function pass(check, msg) {
  notes.push(`[${check}] ${msg}`);
}

function walkMd(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(p));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

/** 收集一个 md 文件里的全部引用目标（markdown 链接 + 行内代码路径） */
function collectRefs(file, content) {
  const refs = [];
  const push = (raw) => {
    if (typeof raw !== 'string') return;
    let target = raw.trim().replace(/^<|>$/g, '');
    if (!target || target.startsWith('#') || SCHEME_RE.test(target)) return;
    target = target.split('#')[0].split('?')[0];
    if (target) refs.push(target);
  };
  // 行内链接/图片： [text](target "title")
  const inlineRe = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  for (const m of content.matchAll(inlineRe)) push(m[1]);
  // 引用式链接定义： [label]: target
  for (const line of content.split('\n')) {
    const m = line.match(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/);
    if (m) push(m[1]);
  }
  // 行内代码中的仓库相对路径（引用路径）
  for (const m of content.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim();
    if (PATH_EXT_RE.test(t) && !/\s/.test(t)) push(t);
  }
  return refs;
}

function refExists(file, target) {
  if (target.startsWith('/')) return fs.existsSync(path.join(root, target));
  if (ROOT_PREFIX_RE.test(target)) {
    return (
      fs.existsSync(path.resolve(path.dirname(file), target)) ||
      fs.existsSync(path.resolve(root, target))
    );
  }
  return fs.existsSync(path.resolve(path.dirname(file), target));
}

// ---------- a. docs/ 下 .md 的相对链接/引用路径真实存在 ----------
function checkLinks() {
  const files = walkMd(docsDir);
  if (files.length === 0) {
    fail('a', 'docs/ 下未找到任何 .md 文件');
    return;
  }
  let refCount = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    const content = fs.readFileSync(file, 'utf8');
    for (const target of collectRefs(file, content)) {
      refCount++;
      if (!refExists(file, target)) {
        fail('a', `${rel}: 引用路径不存在 -> ${target}`);
      }
    }
  }
  if (!failures.some((f) => f.startsWith('[a]'))) {
    pass('a', `docs/ 下 ${files.length} 个 .md、${refCount} 处引用全部存在`);
  }
}

// ---------- b. STATUS based_on 血缘与领先数 ----------
function checkBaseline() {
  if (!fs.existsSync(statusPath)) {
    fail('b', 'docs/STATUS.md 不存在');
    return;
  }
  const firstLine = fs.readFileSync(statusPath, 'utf8').split('\n', 1)[0].trim();
  const m = firstLine.match(/^based_on:\s*([0-9a-f]{7,40})$/);
  if (!m) {
    fail('b', `docs/STATUS.md 第一行不是合法的 based_on 声明（当前为：「${firstLine}」）`);
    return;
  }
  const basedOn = m[1];
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  let head;
  try {
    head = git(['rev-parse', 'HEAD']);
  } catch {
    fail('b', '当前目录不是 git 仓库或 HEAD 不存在');
    return;
  }
  try {
    git(['rev-parse', '--verify', `${basedOn}^{commit}`]);
  } catch {
    fail('b', `based_on 提交 ${basedOn} 不存在于本仓库`);
    return;
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', basedOn, head], { cwd: root, stdio: 'ignore' });
  } catch {
    fail('b', `based_on ${basedOn} 不是当前 HEAD（${head.slice(0, 10)}）的祖先`);
    return;
  }
  let ahead;
  try {
    ahead = Number(git(['rev-list', '--count', `${basedOn}..HEAD`]));
  } catch {
    fail('b', `无法计算 HEAD 相对 ${basedOn} 的领先提交数`);
    return;
  }
  if (!Number.isFinite(ahead) || ahead > 10) {
    fail('b', `HEAD 领先 based_on ${basedOn} 共 ${ahead} 个提交（上限 10）`);
    return;
  }
  pass('b', `based_on=${basedOn} 是 HEAD 祖先，HEAD 领先 ${ahead} 个提交（≤10）`);
}

// ---------- c. DECISIONS D 编号无重复 ----------
function checkDecisionIds() {
  if (!fs.existsSync(decisionsPath)) {
    fail('c', 'docs/DECISIONS.md 不存在');
    return;
  }
  const seen = new Map();
  for (const line of fs.readFileSync(decisionsPath, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*(D\d+)\s*\|/);
    if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}（${n} 次）`);
  if (dupes.length > 0) {
    fail('c', `D 编号重复：${dupes.join('、')}`);
    return;
  }
  pass('c', `D 编号无重复（共 ${seen.size} 条：${[...seen.keys()].join(', ')}）`);
}

// ---------- d. STATUS 与 DECISIONS 不得有 ≥40 字相同行 ----------
function checkNoCopy() {
  if (!fs.existsSync(statusPath) || !fs.existsSync(decisionsPath)) {
    fail('d', 'docs/STATUS.md 或 docs/DECISIONS.md 不存在，无法比对');
    return;
  }
  const MIN = 40;
  const decisionsLines = new Set(
    fs.readFileSync(decisionsPath, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.length >= MIN)
  );
  const statusLines = fs.readFileSync(statusPath, 'utf8').split('\n').map((l) => l.trim());
  const hits = statusLines.filter((l) => l.length >= MIN && decisionsLines.has(l));
  if (hits.length > 0) {
    for (const h of hits) fail('d', `STATUS 与 DECISIONS 存在 ≥${MIN} 字相同行（疑似复制正文）：「${h.length > 60 ? h.slice(0, 60) + '…' : h}」`);
    return;
  }
  pass('d', `两份文档无 ≥${MIN} 字相同行`);
}

checkLinks();
checkBaseline();
checkDecisionIds();
checkNoCopy();

for (const n of notes) console.log(`  ok   ${n}`);
if (failures.length > 0) {
  console.error(`docs-check: ${failures.length} 项失败`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log('docs-check: 全部通过');
