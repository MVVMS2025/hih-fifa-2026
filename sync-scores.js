const admin = require('firebase-admin');
const matches = require('./worldcup-matches.json');

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://hih-fifa-2026-default-rtdb.asia-southeast1.firebasedatabase.app';
const SERVICE_ACCOUNT_BASE64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
const COMPETITION = process.env.FOOTBALL_DATA_COMPETITION || 'WC';
const SEASON = process.env.FOOTBALL_DATA_SEASON || '2026';
const DRY_RUN = process.env.DRY_RUN === 'true';

function required(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

function normalizeTeamName(name) {
  const n = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

  const aliases = {
    unitedstates: 'usa', unitedstatesofamerica: 'usa', usmnt: 'usa', usa: 'usa',
    turkey: 'turkiye', turkiye: 'turkiye',
    southkorea: 'southkorea', korearepublic: 'southkorea', republicofkorea: 'southkorea',
    cotedivoire: 'cotedivoire', ivorycoast: 'cotedivoire',
    curacao: 'curacao',
    bosniaherzegovina: 'bosniaandherzegovina', bosniaandherzegovina: 'bosniaandherzegovina', bih: 'bosniaandherzegovina',
    drcongo: 'drcongo', congodr: 'drcongo', democraticrepublicofcongo: 'drcongo', drc: 'drcongo',
    czechrepublic: 'czechia', czechia: 'czechia',
    newzealand: 'newzealand', nz: 'newzealand',
    capeverde: 'capeverde', caboverde: 'capeverde',
    saudiarabia: 'saudiarabia', saudi: 'saudiarabia',
    holland: 'netherlands', netherlands: 'netherlands'
  };
  return aliases[n] || n;
}

function scoreValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function findLocalMatch(apiHome, apiAway, apiDate) {
  const h = normalizeTeamName(apiHome);
  const a = normalizeTeamName(apiAway);
  const apiTime = apiDate ? new Date(apiDate).getTime() : null;

  for (const m of matches) {
    if (normalizeTeamName(m.home) === h && normalizeTeamName(m.away) === a) return { match: m, reversed: false, method: 'exact' };
  }
  for (const m of matches) {
    if (normalizeTeamName(m.home) === a && normalizeTeamName(m.away) === h) return { match: m, reversed: true, method: 'reversed' };
  }
  if (apiTime && Number.isFinite(apiTime)) {
    let best = null, bestDiff = Infinity;
    for (const m of matches) {
      const diffHours = Math.abs(apiTime - new Date(m.kickoffUTC).getTime()) / 3600000;
      const mh = normalizeTeamName(m.home), ma = normalizeTeamName(m.away);
      const overlap = mh === h || mh === a || ma === h || ma === a;
      if (overlap && diffHours <= 8 && diffHours < bestDiff) {
        best = { match: m, reversed: false, method: `date-overlap-${diffHours.toFixed(1)}h` };
        bestDiff = diffHours;
      }
    }
    if (best) return best;
  }
  return null;
}

async function fetchFootballDataMatches() {
  required('FOOTBALL_DATA_TOKEN', FOOTBALL_DATA_TOKEN);
  const url = `https://api.football-data.org/v4/competitions/${encodeURIComponent(COMPETITION)}/matches?season=${encodeURIComponent(SEASON)}`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN } });
  const text = await res.text();
  if (!res.ok) throw new Error(`football-data.org failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  return { url, matches: data.matches || [], rawCount: (data.matches || []).length };
}

function convertFootballDataMatch(m) {
  const ft = (m.score && m.score.fullTime) || {};
  return {
    apiId: m.id || '',
    status: m.status || '',
    utcDate: m.utcDate || '',
    homeName: (m.homeTeam && m.homeTeam.name) || '',
    awayName: (m.awayTeam && m.awayTeam.name) || '',
    homeScore: scoreValue(ft.home),
    awayScore: scoreValue(ft.away),
    source: 'football-data.org'
  };
}

function initFirebase() {
  required('FIREBASE_SERVICE_ACCOUNT_BASE64', SERVICE_ACCOUNT_BASE64);
  const serviceAccountJson = Buffer.from(SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(serviceAccountJson);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL: FIREBASE_DATABASE_URL });
  return admin.database();
}

async function addActivity(db, type, message) {
  await db.ref('hih_wc2026/activity').push().set({ type, message, time: new Date().toISOString() });
}

async function main() {
  const startedAt = new Date().toISOString();
  const { url, matches: apiMatches, rawCount } = await fetchFootballDataMatches();
  console.log(`Fetched ${rawCount} matches from ${url}`);

  const resultUpdates = {};
  const unmatched = [];
  let skippedNoScore = 0;

  for (const apiMatch of apiMatches.map(convertFootballDataMatch)) {
    const hasScore = apiMatch.homeScore !== null && apiMatch.awayScore !== null;
    const usefulStatus = ['FINISHED', 'IN_PLAY', 'PAUSED', 'LIVE', 'AWARDED'].includes(apiMatch.status);
    if (!hasScore || !usefulStatus) { skippedNoScore++; continue; }

    const found = findLocalMatch(apiMatch.homeName, apiMatch.awayName, apiMatch.utcDate);
    if (!found) {
      unmatched.push({ home: apiMatch.homeName, away: apiMatch.awayName, utcDate: apiMatch.utcDate, score: `${apiMatch.homeScore}-${apiMatch.awayScore}`, status: apiMatch.status });
      continue;
    }

    const local = found.match;
    const home = found.reversed ? apiMatch.awayScore : apiMatch.homeScore;
    const away = found.reversed ? apiMatch.homeScore : apiMatch.awayScore;
    resultUpdates[local.id] = {
      home, away,
      source: apiMatch.source,
      apiId: String(apiMatch.apiId || ''),
      apiStatus: apiMatch.status,
      providerHome: apiMatch.homeName,
      providerAway: apiMatch.awayName,
      matchMethod: found.method,
      updatedAt: new Date().toISOString(),
      updatedBy: 'github_action'
    };
  }

  const syncStatus = {
    lastRunAt: new Date().toISOString(), provider: 'football-data.org', competition: COMPETITION, season: SEASON,
    sourceUrl: url, fetchedMatches: rawCount, savedResults: Object.keys(resultUpdates).length,
    skippedNoScore, unmatchedCount: unmatched.length, unmatched: unmatched.slice(0, 25), status: 'success', startedAt
  };

  console.log('Result updates:', JSON.stringify(resultUpdates, null, 2));
  console.log('Sync status:', JSON.stringify(syncStatus, null, 2));
  if (DRY_RUN) return console.log('DRY_RUN=true, not writing to Firebase');

  const db = initFirebase();
  const writes = { 'hih_wc2026/scoreSync': syncStatus };
  for (const [matchId, result] of Object.entries(resultUpdates)) writes[`hih_wc2026/results/${matchId}`] = result;

  await db.ref().update(writes);
  await addActivity(db, 'score_sync', Object.keys(resultUpdates).length > 0 ? `${Object.keys(resultUpdates).length} result(s) synced from football-data.org` : 'Score sync ran, no completed scores found');
  console.log('Firebase sync completed');
}

main().catch(async (error) => {
  console.error(error);
  try {
    if (SERVICE_ACCOUNT_BASE64) {
      const db = initFirebase();
      await db.ref('hih_wc2026/scoreSync').update({ lastRunAt: new Date().toISOString(), provider: 'football-data.org', status: 'failed', error: String(error.message || error).slice(0, 1000) });
    }
  } catch (secondaryError) { console.error('Could not write failure status to Firebase:', secondaryError); }
  process.exit(1);
});
