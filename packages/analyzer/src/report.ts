import type { Finding, FindingsFile } from './types.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

export function formatMetric(f: Finding): string {
  const v = f.metric.unit === 'ms' ? `${f.metric.value} ms` : f.metric.unit === 'bytes' ? `${Math.round(f.metric.value / 1024)} KiB` : f.metric.unit === 'percent' ? `${f.metric.value}%` : String(f.metric.value);
  return `${f.metric.name}=${v}${f.metric.deterministic ? '' : ' ~'}`;
}

export function formatLocation(f: Finding): string {
  const l = f.location;
  const where = l.file ? `${l.file}${l.line ? `:${l.line}` : ''}` : '';
  return where ? `${l.symbol} (${where})` : l.symbol;
}

/** Ranked table for the terminal. `~` marks time-based (non-deterministic) metrics. */
export function renderTable(file: FindingsFile, limit = 30): string {
  const rows = file.findings.slice(0, limit);
  const lines: string[] = [];
  lines.push(`Findings: ${file.findings.length} (${file.totals.commits} commits, ${file.totals.componentRenders} component renders, ${file.totals.wastedRenders} avoidable, JS busy ${file.totals.jsBusyMs} ms of ${file.totals.traceMs} ms)${file.context.route ? ` route ${file.context.route}` : ''}`);
  lines.push(`${pad('#', 3)} ${pad('sev', 6)} ${pad('kind', 22)} ${pad('metric', 38)} ${pad('where', 54)} fixes`);
  rows.forEach((f, i) => {
    lines.push(`${pad(String(i + 1), 3)} ${pad(f.severity, 6)} ${pad(f.kind, 22)} ${pad(formatMetric(f), 38)} ${pad(formatLocation(f), 54)} ${f.suggestedFixes.join(',')}`);
  });
  if (file.notes.length) {
    lines.push('');
    for (const n of file.notes) lines.push(`note: ${n}`);
  }
  lines.push('');
  lines.push('All numbers: dev build, iOS Simulator. `~` = time-based metric, compare only through an interleaved A/B.');
  return lines.join('\n');
}

export function renderMarkdown(file: FindingsFile, limit = 30): string {
  const rows = file.findings.slice(0, limit);
  const out: string[] = [];
  out.push(`| # | severity | kind | metric | where | suggested fixes |`);
  out.push(`|---|---|---|---|---|---|`);
  rows.forEach((f, i) => out.push(`| ${i + 1} | ${f.severity} | \`${f.kind}\` | ${formatMetric(f)} | ${formatLocation(f).replace(/\|/g, '\\|')} | ${f.suggestedFixes.map((x) => `\`${x}\``).join(' ')} |`));
  return out.join('\n');
}
