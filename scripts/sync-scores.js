const admin = require('firebase-admin');

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const SERVICE_ACCOUNT_BASE64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const ROOT = 'hih_wc2026';
const API_URL = 'https://api.football-data.org/v4/competitions/WC/matches?season=2026';

function required(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

function isoNow() { return new Date().toISOString(); }
function safeText(v) { return (v === undefined || v === null) ? '' : String(v); }
function scoreNumber(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function normalizeFixture(m) {
  const ft = (m.score && m.score.fullTime) || {};
  const ht = (m.homeTeam || {});
  const at = (m.awayTeam || {});
  const apiId = String(m.id);
  return {
    apiId,
    home: safeText(ht.name || ht.shortName || 'TBD'),
    away: safeText(at.name || at.shortName || 'TBD'),
    homeCode: safeText(ht.tla || ''),
    awayCode: safeText(at.tla || ''),
    homeCrest: safeText(ht.crest || ''),
    awayCrest: safeText(at.crest || ''),
    homeTeamId: ht.id ? String(ht.id) : '',
    awayTeamId: at.id ? String(at.id) : '',
    stage: safeText(m.stage || ''),
    group: safeText(m.group || ''),
    matchday: typeof m.matchday === 'number' ? m.matchday : 0,
    status: safeText(m.status || ''),
    kickoffUTC: safeText(m.utcDate || ''),
    venue: safeText(m.venue || ''),
    lastSyncedAt: isoNow(),
    liveHome: scoreNumber(ft.home),
    liveAway: scoreNumber(ft.away)
  };
}

function resultFromMatch(m) {
  const ft = (m.score && m.score.fullTime) || {};
  const home = scoreNumber(ft.home);
  const away = scoreNumber(ft.away);
  if (home === null || away === null) return null;
  if (m.status !== 'FINISHED') return null;
  const ht = m.homeTeam || {};
  const at = m.awayTeam || {};
  return {
    home,
    away,
    source: 'football-data.org',
    apiId: String(m.id),
    apiStatus: safeText(m.status || ''),
    providerHome: safeText(ht.name || ht.shortName || ''),
    providerAway: safeText(at.name || at.shortName || ''),
    matchMethod: 'apiId',
    updatedAt: isoNow(),
    updatedBy: 'github-action'
  };
}

async function main() {
  required('FOOTBALL_DATA_TOKEN', TOKEN);
  required('FIREBASE_SERVICE_ACCOUNT_BASE64', SERVICE_ACCOUNT_BASE64);
  required('FIREBASE_DATABASE_URL', DATABASE_URL);

  const serviceAccount = JSON.parse(Buffer.from(SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
  });

  const db = admin.database();
  console.log(`Fetching ${API_URL}`);
  const response = await fetch(API_URL, { headers: { 'X-Auth-Token': TOKEN }});
  const responseText = await response.text();
  if (!response.ok) {
    await db.ref(`${ROOT}/scoreSync`).update({
      status: 'error',
      provider: 'football-data.org',
      lastRunAt: isoNow(),
      error: `HTTP ${response.status}: ${responseText.slice(0, 500)}`
    });
    throw new Error(`football-data.org failed: HTTP ${response.status}: ${responseText}`);
  }

  const data = JSON.parse(responseText);
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const updates = {};
  let savedFixtures = 0;
  let savedResults = 0;
  let liveCount = 0;
  let scheduledCount = 0;
  let finishedCount = 0;

  for (const match of matches) {
    const apiId = String(match.id);
    const fixture = normalizeFixture(match);
    updates[`${ROOT}/fixtures/${apiId}`] = fixture;
    savedFixtures++;

    if (['IN_PLAY','PAUSED','LIVE'].includes(match.status)) liveCount++;
    if (['SCHEDULED','TIMED'].includes(match.status)) scheduledCount++;
    if (match.status === 'FINISHED') finishedCount++;

    const result = resultFromMatch(match);
    if (result) {
      updates[`${ROOT}/results/${apiId}`] = result;
      savedResults++;
    }
  }

  const syncInfo = {
    status: 'ok',
    provider: 'football-data.org',
    lastRunAt: isoNow(),
    fetchedMatches: matches.length,
    savedFixtures,
    savedResults,
    scheduledCount,
    liveCount,
    finishedCount,
    endpoint: API_URL
  };

  updates[`${ROOT}/scoreSync`] = syncInfo;
  const activityKey = db.ref(`${ROOT}/activity`).push().key;
  updates[`${ROOT}/activity/${activityKey}`] = {
    type: 'score_sync',
    message: `Synced ${savedFixtures} fixtures, ${savedResults} finished results`,
    time: isoNow()
  };

  await db.ref().update(updates);
  console.log('Sync complete:', syncInfo);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
