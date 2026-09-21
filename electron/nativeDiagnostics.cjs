'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const FAMILIES = new Set(['native', 'renderer', 'filesystem', 'canonical']);
const OUTCOMES = new Set(['failed', 'refused', 'cancelled', 'restarted', 'reopened']);
const CODES = new Set(['UNKNOWN', 'RENDERER_CRASHED', 'RENDERER_OOM', 'RENDERER_KILLED', 'RENDERER_UNRESPONSIVE', 'CHILD_PROCESS_GONE', 'RECOVERY_DIALOG_FAILED', 'RECOVERY_FAILED', 'PATH_DENIED', 'INVALID_PATH', 'CANONICAL_MALFORMED', 'CANONICAL_UNREADABLE', 'SAVE_FAILED', 'EACCES', 'ENOSPC', 'EROFS', 'EBUSY', 'EEXIST']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function sanitized(record, historical = false) {
  return { timestamp: historical && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(record?.timestamp) ? record.timestamp : new Date().toISOString(),
    operationId: UUID.test(record?.operationId) ? record.operationId : randomUUID(),
    family: FAMILIES.has(record?.family) ? record.family : 'native',
    outcome: OUTCOMES.has(record?.outcome) ? record.outcome : 'failed',
    code: CODES.has(record?.code) ? record.code : 'UNKNOWN' };
}
function createNativeDiagnostics(directory, { maxRecords = 128, maxBytes = 65536 } = {}) {
  maxRecords = Math.max(1, Math.min(128, maxRecords | 0)); maxBytes = Math.max(1024, Math.min(65536, maxBytes | 0));
  const file = path.join(directory, 'events.json');
  let records = [], pending = [], writing = null, loaded = false, lastWriteOk = true;
  async function writeLoop() {
    if (!loaded) {
      loaded = true;
      let handle;
      try {
        handle = await fs.open(file, 'r'); const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead <= maxBytes) {
          const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
          if (parsed.version === 1 && Array.isArray(parsed.events)) records = parsed.events.slice(-maxRecords).map(value => sanitized(value, true));
        }
      } catch { /* Derived diagnostics never obstruct application work. */ }
      finally { await handle?.close().catch(() => {}); }
    }
    while (pending.length) {
      records = [...records, ...pending.splice(0)].slice(-maxRecords);
      let bytes = JSON.stringify({ version: 1, events: records });
      while (Buffer.byteLength(bytes) > maxBytes && records.length) { records.shift(); bytes = JSON.stringify({ version: 1, events: records }); }
      const temporary = path.join(directory, `.events-${randomUUID()}.tmp`); let handle;
      try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temporary, file); lastWriteOk = true;
      } catch { lastWriteOk = false; }
      finally { await handle?.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {}); }
    }
  }
  function schedule() {
    if (!writing) writing = writeLoop().catch(() => { lastWriteOk = false; }).finally(() => { writing = null; if (pending.length) schedule(); });
  }
  return { file,
    record(input) { const record = sanitized(input); pending.push(record); if (pending.length > maxRecords) pending.splice(0, pending.length - maxRecords); schedule(); return record.operationId; },
    async flush() { while (writing) await writing; return lastWriteOk; },
  };
}
module.exports = { createNativeDiagnostics };
