const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const home = await fetch('https://live.douyin.com/', { headers: { 'User-Agent': UA } });
const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const html = await (await fetch('https://live.douyin.com/', {
  headers: { 'User-Agent': UA, Cookie: cookie },
})).text();
console.log('html', html.length);

const ids = new Set();
for (const re of [
  /web_rid[=\\\":]+(\d{6,})/g,
  /live\.douyin\.com\/(\d{6,})/g,
  /"web_rid":"(\d+)"/g,
  /\\"web_rid\\":\\"(\d+)\\"/g,
]) {
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
}
console.log('ids from home', [...ids].slice(0, 30));

const partitions = ['1', '2', '3', '4', '5', '720', '1000'];
for (const partition of partitions) {
  const url = new URL('https://live.douyin.com/webcast/web/partition/detail/room/2024/');
  url.searchParams.set('aid', '6383');
  url.searchParams.set('app_name', 'douyin_web');
  url.searchParams.set('live_id', '1');
  url.searchParams.set('device_platform', 'web');
  url.searchParams.set('count', '12');
  url.searchParams.set('offset', '0');
  url.searchParams.set('partition', partition);
  url.searchParams.set('partition_type', '1');
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://live.douyin.com/' },
  });
  const body = await res.json().catch(() => ({}));
  const data = body.data?.data ?? [];
  const n = Array.isArray(data) ? data.length : 0;
  console.log('partition', partition, 'status_code', body.status_code, 'n', n);
  if (n) {
    for (const r of data.slice(0, 3)) {
      console.log(' ', {
        web_rid: r.web_rid ?? r.owner?.web_rid,
        room_id: r.room_id ?? r.id_str ?? r.id,
        title: r.title,
      });
    }
    break;
  }
}
