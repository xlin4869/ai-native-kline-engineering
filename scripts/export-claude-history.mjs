// Readable, redacted extraction of a Claude Code session transcript (JSONL). Pass exact files; no directory scan.
// Usage: node scripts/export-claude-history.mjs <session.jsonl> [--out=AI_HISTORY/transcripts/<name>.md] [--until=<ISO>]
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const positional = process.argv.slice(2).filter(x => !x.startsWith('--'));
const options = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--') && x.includes('=')).map(x => {
  const i = x.indexOf('='); return [x.slice(2, i), x.slice(i + 1)];
}));
if (positional.length !== 1) throw new Error('pass exactly one Claude Code session JSONL file');
const source = positional[0];
const until = options.until ? Date.parse(options.until) : Infinity;
const PROJECT = /trade-kline-service|trade-kline-|\.probe\/|baseline-src|scratchpad[\\/](probes|mutant)/;

// Personal paths are derived at run time, so this script itself names no user, host path or workspace.
// Run it from the project directory (take-home/<project>); the workspace root is two levels up.
const SEP = '[\\\\/]+';
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pathPattern = path => path.split(/[\\/]+/).filter(Boolean)
  .map(segment => `(?:${escape(segment)}|${escape(encodeURIComponent(segment))})`).join(SEP); // raw or URL-encoded
const home = pathPattern(homedir());
// The operator's git e-mail and any 5+ character prefix of its local part (e.g. typed into a search pattern).
function emailFragments() {
  let email = '';
  try { email = execFileSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8' }).trim(); } catch { return []; }
  const local = email.split('@')[0] ?? '';
  if (local.length < 5) return [];
  const prefixes = Array.from({ length: local.length - 4 }, (_, i) => escape(local.slice(0, local.length - i)));
  return [[new RegExp(`(?:${prefixes.join('|')})`, 'gi'), '[EMAIL_USER]']];
}
const claudeTemp = `${home}${SEP}AppData${SEP}Local${SEP}Temp${SEP}claude${SEP}[^\\\\/\\s"]+${SEP}[0-9a-f-]{36}`;
const rules = [
  [new RegExp(pathPattern(resolve(process.cwd(), '..', '..')), 'gi'), '[WORKSPACE]'],
  [new RegExp(`${claudeTemp}${SEP}scratchpad`, 'gi'), '[SCRATCHPAD]'],
  [new RegExp(claudeTemp, 'gi'), '[SESSION_TEMP]'],
  [new RegExp(`${home}${SEP}\\.claude${SEP}projects${SEP}[^\\\\/\\s"]+`, 'gi'), '[CLAUDE_PROJECT_DIR]'],
  [new RegExp(home, 'gi'), '[HOME]'],
  [new RegExp(pathPattern(dirname(process.execPath)), 'gi'), '[TOOLS]'],
  [new RegExp(escape(userInfo().username), 'gi'), '[USER]'],
  [new RegExp(escape(basename(resolve(process.cwd(), '..', '..', '..'))), 'g'), '[WORKSPACE_PARENT]'],
  [/[\w.+-]+@[A-Za-z][\w-]*\.[A-Za-z]{2,}/g, '[EMAIL]'],
  [/[0-9a-f]{64}\.resume\.json/gi, '[RESUME_FILE]'],
  [/\bpostgres\d+/g, '[REDACTED]'], // local docker DB default password (or a fragment of it) in a command
  ...emailFragments(),
  [/\b(password|passwd|api[_-]?key|secret|access[_-]?token|gateway[_-]?token|AGENT_GATEWAY_TOKEN|POSTGRES_PASSWORD)\s*[:=]\s*['"]?[^\s'",;]{6,}/gi, '$1=[REDACTED]'],
];
const redact = value => rules.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
const clip = (text, max) => text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters omitted]` : text;
const fence = text => `~~~text\n${text.replaceAll('~~~', '~ ~ ~')}\n~~~`;

const entries = []; const counts = { user: 0, assistantText: 0, toolCalls: 0, toolResultsIncluded: 0, toolResultsOmitted: 0, reasoningOmitted: 0, systemOmitted: 0 };
const toolInputs = new Map();
let sessionId = null; let first = null; let last = null; const sessionIds = new Set();
const reader = createInterface({ input: createReadStream(source, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of reader) {
  let row; try { row = JSON.parse(line); } catch { continue; }
  sessionId ??= row.sessionId ?? null;
  if (row.sessionId) sessionIds.add(row.sessionId); // a resumed session file carries its predecessor's rows too
  const at = Date.parse(row.timestamp ?? '');
  if (Number.isFinite(at) && at > until) continue;
  if (row.type !== 'user' && row.type !== 'assistant') { if (row.type === 'attachment') counts.systemOmitted++; continue; }
  if (row.isSidechain) continue;
  if (Number.isFinite(at)) { first ??= row.timestamp; last = row.timestamp; }
  const content = row.message?.content;
  if (row.type === 'user' && typeof content === 'string') {
    counts.user++;
    entries.push(`### ${row.timestamp} · user\n\n${redact(content)}\n`);
    continue;
  }
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block.type === 'thinking' || block.type === 'redacted_thinking') counts.reasoningOmitted++;
    else if (block.type === 'text' && row.type === 'assistant' && block.text?.trim()) {
      counts.assistantText++;
      entries.push(`### ${row.timestamp} · assistant\n\n${redact(block.text.trim())}\n`);
    } else if (block.type === 'text' && row.type === 'user' && block.text?.trim()) {
      counts.user++;
      entries.push(`### ${row.timestamp} · user\n\n${redact(block.text.trim())}\n`);
    } else if (block.type === 'tool_use') {
      counts.toolCalls++;
      const input = JSON.stringify(block.input ?? {}, null, 1);
      toolInputs.set(block.id, input);
      entries.push(`**tool call** \`${block.name}\` (${row.timestamp})\n\n${fence(clip(redact(input), 1_500))}\n`);
    } else if (block.type === 'tool_result') {
      const input = toolInputs.get(block.tool_use_id) ?? '';
      const text = (Array.isArray(block.content) ? block.content.map(part => part.text ?? '').join('\n') : String(block.content ?? '')).trim();
      if (PROJECT.test(input) && text) {
        counts.toolResultsIncluded++;
        entries.push(`**tool result**${block.is_error ? ' (error)' : ''}\n\n${fence(clip(redact(text), 1_200))}\n`);
      } else counts.toolResultsOmitted++;
    }
  }
}
const out = resolve(options.out ?? join('AI_HISTORY', 'transcripts', `claude-code-${sessionId ?? basename(source, '.jsonl')}.md`));
const header = `# Readable Claude Code transcript (rounds 2–3 and follow-up questions)

Source session IDs: ${[...sessionIds].join(', ') || 'unknown'} (a resumed session file contains the earlier session's rows)
Source file: ${basename(source)}
Covered: ${first ?? '?'} to ${last ?? '?'}${Number.isFinite(until) ? ` (snapshot cut-off ${new Date(until).toISOString()})` : ''}
Tool: Claude Code desktop app; model Opus 5.5.

This is a readable extraction produced by \`scripts/export-claude-history.mjs\`, not a native full-fidelity export.

- **Kept, in order:** every user message, every assistant text block, and every tool call's name and input (truncated to 1,500 characters).
- **Tool results:** an excerpt (up to 1,200 characters) only when the call concerned this project (${counts.toolResultsIncluded} included); the other ${counts.toolResultsOmitted} results are omitted because they contain the private host repository's operating contract, internal task-database rows and unrelated environment data.
- **Omitted entirely:** hidden model reasoning (${counts.reasoningOmitted} blocks), and system, hook and memory injections (${counts.systemOmitted} rows), including the private repository instructions.
- **Redacted:** local user and workspace paths, e-mail addresses, credential-shaped assignments and a Workcell resume-secret file name.

The project's code, tests and \`results/\` files hold the technical outcomes. Counts: ${JSON.stringify(counts)}.

`;
await mkdir(dirname(out), { recursive: true });
await writeFile(out, header + entries.join('\n'), 'utf8');
process.stdout.write(`${JSON.stringify({ out, ...counts, first, last })}\n`);
