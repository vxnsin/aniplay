/**
 * Smoke test against the live site: search → series → season → episode → stream.
 * Run with `npm test`. Needs internet. Exits non-zero when nothing plays.
 */
const aw = require('../lib/aniworld');
const { resolveEpisode, resolveHoster } = require('../lib/stream-resolve');
const { request } = require('../lib/http');

const SLUG = process.argv[2] || 'solo-leveling';

(async () => {
  const t0 = Date.now();
  const results = await aw.search(SLUG.replace(/-/g, ' ').slice(0, 10));
  console.log(`search: ${results.length} Treffer`);

  const series = await aw.getSeries(SLUG);
  console.log(`series: ${series.title} · ${series.seasons.length} Staffeln · cover ${series.cover ? 'ja' : 'nein'}`);

  const season = series.seasons.find((s) => s.num > 0) || series.seasons[0];
  const episodes = await aw.getSeason(season.href);
  console.log(`season ${season.label}: ${episodes.length} Episoden`);
  if (!episodes.length) throw new Error('keine Episoden');

  const ep = await aw.getEpisode(episodes[0].href);
  console.log(`episode: ${ep.title} · ${ep.hosters.length} Hoster-Einträge`);

  const perHoster = {};
  for (const h of ep.hosters.filter((x) => x.langKey === (ep.hosters.find((y) => y.langKey === 1) ? 1 : ep.hosters[0].langKey))) {
    try {
      const r = await resolveHoster(h, ep.url);
      let playable = r.streamType === 'embed' ? 'embed' : 'n/a';
      if (r.streamType !== 'embed') {
        const res = await request(r.url, { headers: { Referer: r.referer, Accept: '*/*' }, timeout: 15000 });
        const head = r.streamType === 'hls' ? (await res.text()).slice(0, 7) : '';
        playable = res.ok && (r.streamType !== 'hls' || head === '#EXTM3U') ? 'OK' : `HTTP ${res.status}`;
      }
      perHoster[h.hosterName] = `${r.streamType} ${playable}`;
    } catch (e) {
      perHoster[h.hosterName] = `FAIL ${e.message.split('\n')[0]}`;
    }
  }
  console.table(perHoster);

  const best = await resolveEpisode(ep.hosters, ep.url, { langKey: 1 });
  console.log(`best: ${best.hosterName} (${best.langLabel}) → ${best.streamType}`);
  if (best.streamType === 'embed') console.warn('WARNUNG: nur Iframe-Fallback verfügbar');
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
})().catch((e) => {
  console.error('SMOKE FAILED:', e.message);
  process.exit(1);
});
