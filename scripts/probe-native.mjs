import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const room = process.argv[2];
if (!room) {
  console.error('Usage: npx tsx scripts/probe-native.mjs <web_rid>');
  process.exit(2);
}

console.log('cwd', process.cwd());
console.log('root', root);

// 1) vendor load like native-client
const libEntry = join(root, 'vendor', 'douyin-danma', 'index.js');
console.log('vendor exists?', await import('node:fs').then((fs) => fs.existsSync(libEntry)), libEntry);
try {
  const mod = await import(pathToFileURL(libEntry).href);
  console.log('vendor default', typeof mod.default);
} catch (e) {
  console.error('VENDOR LOAD FAIL', e);
  process.exit(1);
}

// 2) protobuf resolve from vendor context
try {
  const req = createRequire(libEntry);
  console.log('protobufjs from vendor', req.resolve('protobufjs/minimal.js'));
} catch (e) {
  console.error('PROTOBUF RESOLVE FAIL', e.message);
}

// 3) full NativeLiveClient via tsx-compiled path — load TS through dynamic import of source
const { NativeLiveClient } = await import(pathToFileURL(join(root, 'src', 'native-client.ts')).href);
const logs = [];
const client = new NativeLiveClient({
  roomId: () => room,
  handlers: {
    onMessages: (m) => console.log('msgs', m.length, m[0]?.method),
    onStatus: (s) => console.log('status', s.phase, s.lastError ?? ''),
    onLog: (level, message, data) => {
      logs.push({ level, message, data });
      console.log(`[${level}] ${message}`, data ?? '');
    },
  },
});
await client.start();
await new Promise((r) => setTimeout(r, 10000));
await client.stop();
console.log('error logs:', logs.filter((l) => l.level === 'error'));
