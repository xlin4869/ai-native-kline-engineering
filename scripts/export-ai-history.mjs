import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const workspace = resolve(process.cwd(), '..', '..');

const inputs = process.argv.slice(2);
if (!inputs.length) throw new Error('pass exact Codex JSONL session files; no broad directory scan is performed');
const outputDir = join(process.cwd(), 'AI_HISTORY', 'transcripts');
await mkdir(outputDir, { recursive: true });

function redact(value) {
  return value
    .replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/g, '[REDACTED: private repository agent operating contract]')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '[REDACTED: local environment metadata]')
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/g, '[REDACTED: unrelated plugin inventory]')
    // Derived at run time (run from take-home/<project>) so this script names no user or workspace.
    .replaceAll(workspace, '[WORKSPACE]')
    .replaceAll(workspace.replaceAll('\\', '/'), '[WORKSPACE]')
    .replaceAll(homedir(), '[HOME]')
    .replaceAll(homedir().replaceAll('\\', '/'), '[HOME]')
    .replaceAll('D:\\CodexData', '[CODEX_DATA]')
    .replaceAll('D:/CodexData', '[CODEX_DATA]')
    .replace(/\b[A-Z]:[\\/]downloads[\\/]/gi, '[DOWNLOADS]/')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/\b(password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

for (const source of inputs) {
  let sessionId = null; let agentPath = '/root'; let lastTimestamp = null;
  const turns = []; const toolCounts = new Map();
  const reader = createInterface({ input: createReadStream(source, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'session_meta' && sessionId === null) {
      sessionId = row.payload?.id ?? null;
      agentPath = row.payload?.source?.subagent?.thread_spawn?.agent_path ?? '/root';
    }
    if (row.type !== 'response_item') continue;
    const item = row.payload;
    if (item?.type === 'message' && ['user', 'assistant'].includes(item.role)) {
      const text = (item.content ?? []).map(part => part.text ?? '').join('\n').trim();
      if (text) { turns.push(`### ${row.timestamp} · ${item.role}\n\n${redact(text)}\n`); lastTimestamp = row.timestamp; }
    } else if (['function_call', 'custom_tool_call'].includes(item?.type)) {
      const name = item.name ?? 'unknown'; toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
  }
  const safe = basename(source).replace(/\.jsonl$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
  const out = join(outputDir, `${safe}.md`);
  const header = `# Readable Codex transcript\n\nSource session ID: ${sessionId ?? 'unknown'}  \nAgent path: ${agentPath}  \nSource file: ${basename(source)}  \n\nThis is a faithful extraction of user and assistant message text from the local Codex JSONL session. Hidden reasoning, tool arguments/results and unrelated repository/environment instruction blocks are omitted; local personal paths and credential-shaped assignments are redacted. Tool calls used in this session (name and count only): ${JSON.stringify(Object.fromEntries(toolCounts))}. Technical code/results are in the project and verification record. This is not a native full-fidelity export.\n\n`;
  await writeFile(out, header + `Snapshot cut-off: ${lastTimestamp ?? 'unknown'}. Messages after this cut-off, including the final packaging reply, are outside this snapshot.\n\n` + turns.join('\n'), 'utf8');
  process.stdout.write(`${out}: ${turns.length} messages\n`);
}
