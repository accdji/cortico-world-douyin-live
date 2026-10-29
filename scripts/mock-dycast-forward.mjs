/**
 * Smoke helper: connect as a Dycast-style forwarder and push sample messages
 * into a listening World (bridgeMode=server, bridgeUrl=ws://127.0.0.1:8765).
 *
 *   node scripts/mock-dycast-forward.mjs
 */
import WebSocket from 'ws';

const url = process.argv[2] || 'ws://127.0.0.1:8765';
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('connected to', url);
  ws.send(JSON.stringify({
    roomId: '1',
    roomNum: '123',
    nickname: 'mock',
    title: '本地冒烟直播间',
    status: 2,
  }));
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    ws.send(JSON.stringify([{
      method: 'WebcastChatMessage',
      id: String(n),
      content: `冒烟弹幕 #${n}`,
      user: { id: 'u-mock', name: '测试观众' },
    }]));
    if (n >= 5) {
      clearInterval(timer);
      ws.send(JSON.stringify([{
        method: 'WebcastGiftMessage',
        id: 'g1',
        user: { id: 'u-vip', name: '土豪' },
        gift: { name: '玫瑰', price: 10, count: 1 },
      }]));
      setTimeout(() => ws.close(), 500);
    }
  }, 400);
});

ws.on('close', () => {
  console.log('done');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});
