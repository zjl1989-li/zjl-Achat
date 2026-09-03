// Real local agent (the "brain" the monitor invokes per task). It does GENUINE
// work - fetches live GitHub data and writes an analysis report - WITHOUT any
// LLM call. This proves the bridge needs no LLM: the agent owns the thinking,
// achat only shuttles. Swap this file for any local agent (Codex CLI, a script
// that drives WorkBuddy/豆包 via UI automation, etc.) to bridge a real product.
// ASCII only.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const taskPath = process.argv[2];
const artifactsDir = process.env.ACHAT_ARTIFACTS_DIR || join(process.cwd(), 'bridge', 'demo', 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

function fail(msg) {
  process.stdout.write(JSON.stringify({ conclusion: '[demo-agent] ' + msg }));
  process.exit(0);
}

let task;
try { task = JSON.parse(readFileSync(taskPath, 'utf8')); }
catch { fail('无法读取任务文件'); }

const instruction = String(task.instruction || '');
const role = String(task.role || '');

// --- pick a repo from the instruction -------------------------------------
function pickRepo(text) {
  const slug = text.match(/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (slug) return slug[1] + '/' + slug[2];
  // Chinese keyword -> english query
  if (text.includes('量化')) return 'freqtrade/freqtrade';
  if (text.includes('交易')) return 'freqtrade/freqtrade';
  if (text.includes('代码') || text.includes('开发')) return 'microsoft/vscode';
  return null;
}

async function ghJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'zjl-achat-bridge', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

(async () => {
  let repo = pickRepo(instruction);
  let data;
  try {
    if (repo) {
      data = await ghJson(`https://api.github.com/repos/${repo}`);
    } else {
      // no explicit repo: search and take the top star result
      const q = encodeURIComponent('quantitative trading stars:>5000');
      const s = await ghJson(`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=1`);
      if (!s.items || !s.items.length) throw new Error('no search result');
      data = s.items[0];
      repo = data.full_name;
    }
  } catch (e) {
    return fail('GitHub 抓取失败：' + e.message);
  }

  const stars = data.stargazers_count ?? 0;
  const forks = data.forks_count ?? 0;
  const open = data.open_issues_count ?? 0;
  const lang = data.language || 'N/A';
  const lic = data.license && data.license.spdx_id ? data.license.spdx_id : 'N/A';
  const created = (data.created_at || '').slice(0, 10);
  const pushed = (data.pushed_at || '').slice(0, 10);
  const ageYears = created ? ((Date.now() - new Date(data.created_at).getTime()) / 3.154e10).toFixed(1) : '?';
  const topics = (data.topics || []).join(', ') || '（无）';

  // Plain-data takeaways (no LLM): just operational facts + a couple of ratios.
  const commitActivityNote = `Stars ${stars.toLocaleString()} / Forks ${forks.toLocaleString()} / Open issues ${open.toLocaleString()} · 活跃度 strain = stars/age ≈ ${(stars / Math.max(1, Number(ageYears))).toFixed(0)}/年`;

  const md = `# GitHub 项目分析报告

**项目**：${data.full_name}
**一句话**：${data.description || '（无描述）'}

## 实时数据（来自 GitHub API）
| 指标 | 值 |
|---|---|
| Star | ${stars.toLocaleString()} |
| Fork | ${forks.toLocaleString()} |
| Open Issues | ${open.toLocaleString()} |
| 主语言 | ${lang} |
| License | ${lic} |
| 创建 | ${created}（约 ${ageYears} 年） |
| 最近推送 | ${pushed} |
| 主题标签 | ${topics} |

## 结论（数据直读，无 LLM 润色）
- ${commitActivityNote}
- 主语言 ${lang}，协议 ${lic}。
- 最早提交 ${created}，最近仍活跃于 ${pushed}，说明${pushed >= '2025-01-01' ? '维护活跃' : '近期不活跃，需谨慎'}。

> 注：本报告由桥接侧的"真 agent"（demo-agent.mjs）直接调用 GitHub API 生成，
> 桥接传输层（bridge-monitor）未消耗任何 LLM token。
`;

  const safe = repo.replace(/[\\/]/g, '_');
  const fname = `gh-${safe}-report.md`;
  const fpath = join(artifactsDir, fname);
  writeFileSync(fpath, md);

  const conclusion = `已基于 GitHub 实时数据生成「${data.full_name}」分析报告：`
    + `${stars.toLocaleString()} stars / ${lang} / ${lic}，创建于 ${created}、最近推送 ${pushed}。`
    + `报告已生成并放入群空间。`;

  process.stdout.write(JSON.stringify({
    conclusion,
    artifacts: [{ type: 'doc', name: fname, path: fpath }],
  }));
  process.exit(0);
})();
