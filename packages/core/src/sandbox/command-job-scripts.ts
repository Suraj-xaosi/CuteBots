export const COMMAND_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export const COMMAND_JOB_START_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const id = process.argv[1];
const command = process.argv[2];
const outputLimit = Number(process.argv[3]);
const root = '/tmp/cutebots-command-jobs';
const directory = path.join(root, id);
fs.mkdirSync(root, { recursive: true });
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  const entryPath = path.join(root, entry.name);
  try {
    if (Date.now() - fs.statSync(entryPath).mtimeMs > ${COMMAND_JOB_MAX_AGE_MS}) fs.rmSync(entryPath, { recursive: true, force: true });
  } catch {}
}
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'created'), String(Date.now()));
fs.writeFileSync(path.join(directory, 'status'), 'running');
const outputPath = path.join(directory, 'output');
const child = spawn('bash', ['-lc', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
fs.writeFileSync(path.join(directory, 'pid'), String(child.pid));
let written = 0;
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    const remaining = outputLimit - written;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      fs.appendFileSync(outputPath, kept);
      written += kept.length;
    }
    if (chunk.length > remaining) fs.writeFileSync(path.join(directory, 'truncated'), '1');
  });
}
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
}, 30 * 60 * 1000);
child.on('error', (error) => {
  fs.writeFileSync(outputPath, String(error));
  fs.writeFileSync(path.join(directory, 'exit'), '127');
  fs.writeFileSync(path.join(directory, 'status'), 'failed');
  clearTimeout(timeout);
});
child.on('close', (code) => {
  clearTimeout(timeout);
  fs.writeFileSync(path.join(directory, 'exit'), String(code ?? 1));
  const cancelled = fs.existsSync(path.join(directory, 'cancel-requested'));
  fs.writeFileSync(path.join(directory, 'status'), timedOut ? 'timed_out' : cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed');
});
`;

export const COMMAND_JOB_POLL_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const id = process.argv[1];
const offset = Number(process.argv[2]);
const limit = Number(process.argv[3]);
const maxAge = Number(process.argv[4]);
const directory = path.join('/tmp/cutebots-command-jobs', id);
if (!fs.existsSync(directory)) { process.stderr.write('Unknown or expired command job'); process.exit(2); }
const created = Number(fs.readFileSync(path.join(directory, 'created'), 'utf8'));
if (Date.now() - created > maxAge) { fs.rmSync(directory, { recursive: true, force: true }); process.stderr.write('Unknown or expired command job'); process.exit(2); }
const outputPath = path.join(directory, 'output');
const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
const available = Math.max(0, Math.min(size - offset, limit));
let output = '';
if (available > 0) {
  const fd = fs.openSync(outputPath, 'r');
  const buffer = Buffer.alloc(available);
  fs.readSync(fd, buffer, 0, available, offset);
  fs.closeSync(fd);
  output = buffer.toString('utf8');
}
const status = fs.readFileSync(path.join(directory, 'status'), 'utf8');
const exitPath = path.join(directory, 'exit');
process.stdout.write(JSON.stringify({
  jobId: id,
  status,
  output,
  nextOffset: offset + available,
  exitCode: fs.existsSync(exitPath) ? Number(fs.readFileSync(exitPath, 'utf8')) : null,
  outputTruncated: fs.existsSync(path.join(directory, 'truncated')),
}));
`;

export const COMMAND_JOB_CANCEL_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join('/tmp/cutebots-command-jobs', process.argv[1]);
if (!fs.existsSync(directory)) { process.stderr.write('Unknown or expired command job'); process.exit(2); }
const statusPath = path.join(directory, 'status');
if (fs.readFileSync(statusPath, 'utf8') !== 'running') process.exit(0);
fs.writeFileSync(path.join(directory, 'cancel-requested'), '1');
const pid = Number(fs.readFileSync(path.join(directory, 'pid'), 'utf8'));
try { process.kill(-pid, 'SIGTERM'); } catch {}
for (let attempt = 0; attempt < 50; attempt++) {
  try { process.kill(-pid, 0); } catch { process.exit(0); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
try { process.kill(-pid, 'SIGKILL'); } catch {}
`;
