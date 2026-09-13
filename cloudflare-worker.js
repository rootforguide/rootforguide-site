/**
 * RootForGuide.com — Live Scoring Worker
 * ========================================
 * Deploy to Cloudflare Workers. Fetches live data from CollegeFootballData.com
 * server-side, computes the actual Game Gravity score HERE (not in the
 * browser), and returns only that finished, derived output.
 *
 * IMPORTANT — why this shape, not a raw data passthrough: CFBD's Terms of
 * Use (Section 5) prohibit operating "a raw feed, public database mirror,
 * proxy, substitute API, or substantially equivalent data service" or
 * giving "programmatic access to stored raw API responses." This Worker
 * fetches raw games/lines/rankings/team-game-log data, but NEVER returns
 * that raw data to the client — only the computed Game Gravity results,
 * which are Derived Output under Section 4 and fine to serve and monetize.
 *
 * SETUP (account-level steps only you can do):
 * 1. Free API key: https://collegefootballdata.com -> sign up
 * 2. Cloudflare dashboard -> Workers & Pages -> Create Worker -> paste this in
 * 3. Worker -> Settings -> Variables -> add ENCRYPTED secret: CFBD_API_KEY
 * 4. Deploy -- you'll get a URL like https://rootforguide-data.<you>.workers.dev
 * 5. Send me that URL and I'll wire the site's frontend to call it.
 *
 * Request shape:
 *   GET /?team=BYU&year=2026&week=1
 *   (Scoreboard Only / Colley Matrix mode has been removed entirely --
 *   distracting and not reliably accurate this early in most seasons.
 *   The Committee lens is the only mode now.)
 *
 *   GET /?year=2026&week=1   (no team) -- national ranked-games mode:
 *   every game that week involving at least one ranked team, in
 *   chronological order. Response: { year, week, games, pollSource }
 *
 * Response shape:
 *   { team, week, pollSource, lastGame, results: [ {score, tier, reason,
 *     rootFor, home, away, homeRank, awayRank, kickoffUTC, network,
 *     favoredTeam, winProb, home_score, away_score}, ... ] }
 *
 * Honest limitation: this file has been written carefully against CFBD's
 * documented field shapes (camelCase: homeTeam, awayTeam, homePoints,
 * awayPoints, startDate, spread, polls/ranks, etc.), but it has NOT been
 * run against a live key/deployment -- I have no way to do that from here.
 * Test it after deploying and send me any errors to fix.
 */

const CFBD_BASE = "https://api.collegefootballdata.com";
const ALLOWED_ORIGIN = "https://rootforguide.com";
const TOTAL_SEASON_WEEKS = 14;
const CFP_START_WEEK = 10;

// A starter rivalry list, not exhaustive -- covers the most
// widely-recognized matchups across conferences. Easy to extend later;
// deliberately kept reasonable in scope rather than attempting every
// regional/historical rivalry in FBS.
const RIVALRIES = {
  "BYU": ["Utah"], "Utah": ["BYU", "Utah State"], "Utah State": ["Utah"],
  "Ohio State": ["Michigan"], "Michigan": ["Ohio State"],
  "Texas": ["Oklahoma", "Texas A&M"], "Oklahoma": ["Texas", "Oklahoma State"],
  "Texas A&M": ["Texas", "LSU"], "Oklahoma State": ["Oklahoma"],
  "Alabama": ["Auburn", "Tennessee"], "Auburn": ["Alabama"],
  "Tennessee": ["Alabama", "Vanderbilt", "Florida"],
  "Georgia": ["Florida", "Georgia Tech", "Auburn"],
  "Florida": ["Georgia", "Florida State", "Tennessee"],
  "Florida State": ["Florida", "Miami (FL)"],
  "Miami (FL)": ["Florida State"],
  "USC": ["UCLA", "Notre Dame"], "UCLA": ["USC"],
  "Notre Dame": ["USC", "Michigan", "Michigan State"],
  "Michigan State": ["Michigan", "Notre Dame"],
  "LSU": ["Texas A&M", "Ole Miss"], "Ole Miss": ["LSU", "Mississippi State"],
  "Mississippi State": ["Ole Miss"],
  "Oregon": ["Oregon State", "Washington"], "Oregon State": ["Oregon"],
  "Washington": ["Oregon", "Washington State"], "Washington State": ["Washington"],
  "Clemson": ["South Carolina"], "South Carolina": ["Clemson"],
  "Penn State": ["Michigan State", "Ohio State"],
  "Indiana": ["Purdue"], "Purdue": ["Indiana"],
  "Iowa": ["Iowa State", "Wisconsin", "Nebraska"], "Iowa State": ["Iowa"],
  "Nebraska": ["Iowa"], "Wisconsin": ["Iowa", "Minnesota"],
  "Minnesota": ["Wisconsin"],
  "Kansas": ["Kansas State", "Missouri"], "Kansas State": ["Kansas"],
  "Missouri": ["Kansas"],
  "Virginia": ["Virginia Tech"], "Virginia Tech": ["Virginia"],
  "North Carolina": ["Duke", "NC State"], "Duke": ["North Carolina"],
  "NC State": ["North Carolina"],
  "Louisville": ["Kentucky"], "Kentucky": ["Louisville"],
  "Houston": ["Texas Tech"], "Texas Tech": ["Houston", "Texas"]
};

async function cfbdFetch(env, path, params) {
  const url = new URL(CFBD_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${env.CFBD_API_KEY}` }
  });
  if (!res.ok) throw new Error(`CFBD ${path} failed: ${res.status}`);
  return res.json();
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

// ---------------------------------------------------------------------
// Core math -- ported from the site's client-side engine, no DOM needed
// ---------------------------------------------------------------------

function spreadToWinProb(spread) {
  if (spread === undefined || spread === null) return null;
  const k = 14.0;
  const margin = Math.abs(spread);
  const prob = 1 / (1 + Math.exp(-margin / (k / 4)));
  return Math.min(prob, 0.99);
}

function seasonMultiplier(week) {
  const progress = Math.min(Math.max(week - 1, 0), TOTAL_SEASON_WEEKS - 1) / (TOTAL_SEASON_WEEKS - 1);
  return 1 + progress * 0.6;
}

function isEliminationGame(userRank, week) {
  if (userRank === null) return false;
  // Narrowed on purpose: this used to fire for ANY game across a
  // 3-week window (12-14) just because the rank happened to be near
  // the cutoff -- which incorrectly flagged ordinary games (like a
  // regular-season game against a non-championship opponent) as
  // "win and you're in." Now only the truly final stretch of the
  // season qualifies, not just "late enough."
  if (week < TOTAL_SEASON_WEEKS - 1) return false;
  return Math.abs(userRank - 12) <= 1;
}

function rankOf(team, pollRanks) {
  const e = pollRanks.find(r => r.school.toLowerCase() === team.toLowerCase());
  return e ? e.rank : null;
}

function pollSource(week) {
  return week >= CFP_START_WEEK ? "CFP" : "AP";
}

function extractPollRanks(rankingsResponse, week) {
  // Never silently substitute a different week's poll for the one
  // actually requested -- that's exactly how a "last week" display
  // can end up showing today's rankings instead. If there's no exact
  // match, fall back to the closest PRIOR week only (never a later
  // one, and never just "whatever's newest").
  //
  // 5-whys note (LSU/Ole Miss showing unranked, investigated but not
  // yet confirmed fixed -- needs live verification against the
  // deployed Worker, not just code review):
  //   1. Why would a genuinely-ranked team show as unranked? Because
  //      this function found no matching poll entry for them.
  //   2. Why would the entry be missing? Either CFBD's response
  //      genuinely lacks them (unlikely -- confirmed ranked via
  //      independent web search), or `week` here doesn't match
  //      whatever week number CFBD's /rankings response actually
  //      uses for the current poll.
  //   3. Why would `week` be wrong? It's computed upstream from the
  //      site's own current-week detection, which may not be in
  //      sync with CFBD's OWN internal week numbering for polls
  //      specifically (games and polls are not guaranteed to share
  //      the same week-numbering convention).
  //   4. Why would those two numbering conventions diverge? Not
  //      confirmed -- would need a live response from CFBD's
  //      /rankings endpoint to compare its actual `week` values
  //      against the site's computed "current week" side by side.
  //   5. Root cause: unconfirmed without live API access. This
  //      comment exists so the next debugging pass starts here
  //      instead of re-deriving all of the above from scratch.
  let weekData = rankingsResponse.find(r => r.week === week);
  if (!weekData) {
    const priorWeeks = rankingsResponse.filter(r => r.week < week).sort((a, b) => b.week - a.week);
    weekData = priorWeeks[0] || null;
  }
  if (!weekData) return { ranks: [], warning: null };
  const wantedName = pollSource(week) === "CFP" ? "Playoff Committee Rankings" : "AP Top 25";
  const poll = (weekData.polls || []).find(p => p.poll === wantedName) || (weekData.polls || [])[0];
  const ranks = poll ? poll.ranks : [];

  // Redundancy layer 3: a sanity check on the RESULT, independent of
  // how we got here. A real AP/CFP poll always has exactly 25 unique
  // schools, ranks 1-25 with no gaps or repeats. If that's not what
  // we got, something upstream is wrong (wrong week matched, a
  // malformed CFBD response, etc) -- surface it as a warning on the
  // response instead of silently serving data that LOOKS complete
  // but isn't, so it's visible in the live response for debugging
  // rather than only discoverable by a user noticing a missing team.
  let warning = null;
  if (ranks.length !== 25) {
    warning = `Poll for week ${weekData.week} has ${ranks.length} ranked teams, not the expected 25.`;
  } else {
    const schools = new Set(ranks.map(r => r.school));
    const rankNums = new Set(ranks.map(r => r.rank));
    if (schools.size !== 25) warning = `Poll for week ${weekData.week} has duplicate schools.`;
    else if (rankNums.size !== 25) warning = `Poll for week ${weekData.week} has duplicate or missing rank numbers.`;
  }
  return { ranks, warning, resolvedWeek: weekData.week };
}

// The full Colley matrix (linear-algebra rating solve) used to live
// here, but its rating output was only ever displayed in "Scoreboard
// Only" mode, which has been removed as distracting and not reliably
// accurate this early in most seasons (too few connected games). All
// that networkConfidence() ever actually needed was a games-played
// count, so that's all this computes now -- same downstream shape
// ({team: {games}}), far simpler, no matrix, no solver.
function gamesPlayedCounts(seasonGames, teamList) {
  const counts = {};
  teamList.forEach(t => { counts[t] = 0; });
  seasonGames
    .filter(g => g.homePoints !== null && g.awayPoints !== null && g.homePoints !== undefined && g.awayPoints !== undefined)
    .forEach(g => {
      if (g.homeTeam in counts) counts[g.homeTeam]++;
      if (g.awayTeam in counts) counts[g.awayTeam]++;
    });
  const result = {};
  teamList.forEach(t => { result[t] = { games: counts[t] }; });
  return result;
}

function networkConfidence(ratings, team) {
  const games = ratings[team] ? ratings[team].games : 0;
  return Math.min(1, 0.5 + games * 0.1);
}

// A real Colley matrix (linear-algebra rating solve), scoped
// specifically to the Top 25 table's "what they'd be ranked by the
// math" column. This is intentionally kept separate from
// networkConfidence()'s lightweight games-played counter above --
// that one only ever needed a games count, not an actual rating,
// so it stays simple. This full computation only runs for the Top
// 25 table request, not on every regular team lookup.
function solveLinearSystem(C, b) {
  const n = b.length;
  const M = C.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < 1e-10) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-10 ? 0.5 : row[n] / row[i]));
}

function colleyRatingsFull(seasonGames, teamList) {
  const idx = {};
  teamList.forEach((t, i) => (idx[t] = i));
  const n = teamList.length;
  const C = Array.from({ length: n }, () => new Array(n).fill(0));
  const gamesPlayed = new Array(n).fill(0);
  const wins = new Array(n).fill(0);
  const losses = new Array(n).fill(0);

  seasonGames
    .filter(g => g.homePoints !== null && g.awayPoints !== null && g.homePoints !== undefined && g.awayPoints !== undefined)
    .forEach(g => {
      const winner = g.homePoints > g.awayPoints ? g.homeTeam : g.awayTeam;
      const loser = g.homePoints > g.awayPoints ? g.awayTeam : g.homeTeam;
      if (!(winner in idx) || !(loser in idx)) return;
      const wi = idx[winner], li = idx[loser];
      C[wi][li] -= 1; C[li][wi] -= 1;
      gamesPlayed[wi]++; gamesPlayed[li]++;
      wins[wi]++; losses[li]++;
    });
  for (let i = 0; i < n; i++) C[i][i] = 2 + gamesPlayed[i];
  const b = teamList.map((_, i) => 1 + (wins[i] - losses[i]) / 2);
  const ratings = solveLinearSystem(C, b);
  const result = {};
  teamList.forEach((t, i) => { result[t] = { rating: ratings[i], games: gamesPlayed[i] }; });
  return result;
}

function buildResume(team, teamSeasonGames) {
  const resume = {};
  teamSeasonGames
    .filter(g => g.homePoints !== null && g.awayPoints !== null && g.homePoints !== undefined && g.awayPoints !== undefined)
    .forEach(g => {
      const isHome = g.homeTeam.toLowerCase() === team.toLowerCase();
      const opp = isHome ? g.awayTeam : g.homeTeam;
      const teamScore = isHome ? g.homePoints : g.awayPoints;
      const oppScore = isHome ? g.awayPoints : g.homePoints;
      resume[opp] = { result: teamScore > oppScore ? "beat" : "lost_to", teamScore, oppScore };
    });
  return resume;
}

function watchLink(home, away, year) {
  const q = encodeURIComponent(`${away} vs ${home} condensed highlights ${year}`);
  return `https://www.youtube.com/results?search_query=${q}`;
}

// ---------------------------------------------------------------------
// Main scoring -- mirrors the site's five-tier engine
// ---------------------------------------------------------------------

function scoreWeekServerSide(team, year, week, weekGames, weekLines, pollRanks, teamConferences, ratings, resume) {
  const userRank = rankOf(team, pollRanks);
  const myConference = teamConferences[team] || null;
  const rankWindow = 12;
  const windowLabel = "playoff bubble";
  const seasonMult = seasonMultiplier(week);
  const results = [];

  weekGames.forEach(g => {
    const home = g.homeTeam, away = g.awayTeam;
    const homeRank = rankOf(home, pollRanks), awayRank = rankOf(away, pollRanks);
    const lineEntry = (weekLines || []).find(l => l.id === g.id);
    let favoredTeam = null, winProb = null;
    if (lineEntry && lineEntry.lines && lineEntry.lines.length) {
      const spread = parseFloat(lineEntry.lines[0].spread);
      if (!isNaN(spread)) {
        favoredTeam = spread < 0 ? home : spread > 0 ? away : null;
        winProb = spreadToWinProb(spread);
      }
    }
    const link = watchLink(home, away, year);
    const kickoffUTC = g.startDate || null;
    const network = (g.venue && g.venue.tv) || g.tv || null;
    const home_score = g.homePoints ?? null;
    const away_score = g.awayPoints ?? null;
    const common = { game_id: g.id, home, away, homeRank, awayRank, favoredTeam, winProb, link, kickoffUTC, network, home_score, away_score };

    const isYourGame = team.toLowerCase() === home.toLowerCase() || team.toLowerCase() === away.toLowerCase();
    if (isYourGame) {
      const elimination = isEliminationGame(userRank, week);
      const opponent = team.toLowerCase() === home.toLowerCase() ? away : home;
      const oppRank = team.toLowerCase() === home.toLowerCase() ? awayRank : homeRank;
      let score, reason;
      if (elimination) {
        score = 100.0;
        reason = `${team} is sitting right on the ${windowLabel} cutoff (#${userRank}) this late in the season -- win and you're in, lose and it's basically over.`;
      } else {
        const rankedBonus = oppRank !== null ? 15 : 0;
        let closenessBonus = 8;
        if (winProb !== null) closenessBonus = (1 - Math.abs(winProb - 0.5) * 2) * 15;
        const latenessBonus = Math.round((seasonMult - 1) * 20);
        score = Math.min(99, Math.round(60 + rankedBonus + closenessBonus + latenessBonus));
        reason = oppRank !== null
          ? `${team} is playing ${opponent} (#${oppRank}) -- a loss here would genuinely hurt.`
          : `${team} is playing ${opponent} (unranked) -- ${team} is favored, but an upset loss here would be a real, lasting blow to the playoff resume, one most teams can't just shake off.`;
      }
      results.push({ ...common, tier: "Your Team", rootFor: team, reason, score, elimination });
      return;
    }

    let best = null;

    if (userRank !== null) {
      [[home, homeRank], [away, awayRank]].forEach(([cand, candRank]) => {
        if (candRank === null || candRank === userRank) return;
        const distance = Math.abs(candRank - userRank);
        if (distance > rankWindow) return;
        const opponent = cand === home ? away : home;
        const proximityWeight = 1 - distance / (rankWindow + 1);
        const estimatedSpots = Math.max(1, Math.round(proximityWeight * 8));
        const confidence = networkConfidence(ratings, cand);
        const base = 40 + estimatedSpots * 6;
        const score = Math.min(98, Math.round(base * confidence * seasonMult * 10) / 10);
        const reason = candRank < userRank
          ? `${cand} is ranked #${candRank}, ahead of ${team} (#${userRank}). A loss here is worth an estimated ${estimatedSpots} spot(s) toward the ${windowLabel} cutoff (${Math.round(confidence * 100)}% network confidence).`
          : `${cand} is ranked #${candRank}, closing in on ${team} (#${userRank}). A loss here is worth an estimated ${estimatedSpots} spot(s) of cushion (${Math.round(confidence * 100)}% network confidence).`;
        if (!best || score > best.score) best = { ...common, tier: "Ranking Battle", rootFor: opponent, reason, score };
      });
    }

    [home, away].forEach(cand => {
      if (resume[cand]) {
        const outcome = resume[cand].result;
        const candRank = rankOf(cand, pollRanks);
        const isRivalToo = userRank !== null && candRank !== null && Math.abs(candRank - userRank) <= rankWindow;
        const confidence = networkConfidence(ratings, cand);
        let reason, weight, base, tier;
        if (isRivalToo) {
          tier = "Head-to-Head"; base = 85;
          reason = outcome === "beat"
            ? `${team} already beat ${cand} head-to-head -- a real tiebreaker in ${team}'s favor (${Math.round(confidence * 100)}% network confidence).`
            : `${cand} beat ${team} head-to-head already -- a loss for them offsets that (${Math.round(confidence * 100)}% network confidence).`;
          weight = outcome === "beat" ? 0.85 : 0.75;
        } else {
          tier = "Resume Connection"; base = 60;
          reason = outcome === "beat"
            ? `${team} already beat ${cand} -- their win this week raises that win's value (${Math.round(confidence * 100)}% network confidence).`
            : `${team} lost to ${cand} earlier -- their win this week softens that loss (${Math.round(confidence * 100)}% network confidence).`;
          weight = outcome === "beat" ? 0.7 : 0.55;
        }
        const score = Math.min(98, Math.round(base * weight * confidence * seasonMult * 10) / 10);
        if (!best || score > best.score) best = { ...common, tier, rootFor: cand, reason, score };
      }
    });

    if (myConference) {
      const homeConf = teamConferences[home], awayConf = teamConferences[away];
      if ((homeConf === myConference || awayConf === myConference) && !isYourGame) {
        const confMate = homeConf === myConference ? home : away;
        const opponent = homeConf === myConference ? away : home;
        const confMateRank = rankOf(confMate, pollRanks);
        const confidence = networkConfidence(ratings, confMate);
        const score = Math.min(92, Math.round(48 * confidence * seasonMult * 10) / 10);
        const reason = `${confMate} is a fellow ${myConference} team${confMateRank ? ` (#${confMateRank})` : ""} -- a win over ${opponent} raises the conference's national standing (${Math.round(confidence * 100)}% network confidence).`;
        if (!best || score > best.score) best = { ...common, tier: "Conference Watch", rootFor: confMate, reason, score };
      }
    }

    if (homeRank !== null || awayRank !== null) {
      const featuredRank = Math.min(homeRank ?? 999, awayRank ?? 999);
      const featuredTeam = homeRank === featuredRank ? home : away;
      const underdog = homeRank !== null && awayRank !== null
        ? (homeRank > awayRank ? home : away)
        : (homeRank !== null ? away : home);
      const confidence = networkConfidence(ratings, featuredTeam);
      const base = featuredRank <= 10 ? 55 : featuredRank <= 25 ? 42 : 30;
      const score = Math.min(90, Math.round(base * confidence * seasonMult * 10) / 10);
      const reason = `${featuredTeam} is ranked #${featuredRank} -- an upset here reshuffles marquee wins nationally (${Math.round(confidence * 100)}% network confidence).`;
      if (!best || score > best.score) best = { ...common, tier: "National Resume Watch", rootFor: underdog, reason, score };
    }

    if (best) results.push(best);
  });

  return results.sort((a, b) => {
    if (a.tier === "Your Team" && b.tier !== "Your Team") return -1;
    if (b.tier === "Your Team" && a.tier !== "Your Team") return 1;
    return b.score - a.score;
  });
}

// ---------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    const team = url.searchParams.get("team");
    const year = url.searchParams.get("year") || "2026";
    const week = parseInt(url.searchParams.get("week") || "1", 10);
    const mode = url.searchParams.get("mode");

if (!team && mode === "currentweek") {
      // Determines the real current week from CFBD's own calendar of
      // week start/end dates for the season -- comparing today's real
      // date against actual boundaries, rather than a hardcoded
      // formula that would drift wrong as soon as the season's real
      // schedule doesn't match some assumed pattern.
      const cwCacheKey = new Request(url.toString(), request);
      const cwCache = caches.default;
      const cwCached = await cwCache.match(cwCacheKey);
      if (cwCached) return cwCached;

      try {
        const calendar = await cfbdFetch(env, "/calendar", { year });
        const now = new Date();
        const regularWeeks = calendar
          .filter(w => w.seasonType === "regular")
          .sort((a, b) => a.week - b.week);

        let currentWeek = null;
        for (const w of regularWeeks) {
          if (now >= new Date(w.startDate) && now <= new Date(w.endDate)) {
            currentWeek = w.week;
            break;
          }
        }
        if (currentWeek === null) {
          const passed = regularWeeks.filter(w => new Date(w.startDate) <= now);
          if (passed.length) currentWeek = passed[passed.length - 1].week;
        }

        const cwBody = JSON.stringify({ year, week: currentWeek });
        // Cached for 1 hour, not 24 -- this one genuinely changes as
        // the days pass, unlike the per-week data which is stable
        // for the whole week once computed.
        const cwResponse = new Response(cwBody, { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=3600" } });
        ctx.waitUntil(cwCache.put(cwCacheKey, cwResponse.clone()));
        return cwResponse;
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: corsHeaders() });
      }
    }

    if (!team && mode === "top25") {
      // ESPN-style Top 25 table: every currently ranked team with its
      // real record, week-over-week trend, a Colley-matrix-computed
      // rank for comparison against the human poll, and its last/next
      // game. One heavier request than the others (needs the full
      // season's games plus two weeks of polls), so it's cached the
      // same 24 hours as everything else.
      const top25CacheKey = new Request(url.toString(), request);
      const top25Cache = caches.default;
      const top25Cached = await top25Cache.match(top25CacheKey);
      if (top25Cached) return top25Cached;

      try {
        const [seasonGames, rankingsRaw, teamsInfo] = await Promise.all([
          cfbdFetch(env, "/games", { year, seasonType: "regular" }),
          cfbdFetch(env, "/rankings", { year, seasonType: "regular" }),
          cfbdFetch(env, "/teams", { year })
        ]);

        const currentPollResult = extractPollRanks(rankingsRaw, week);
        const currentPoll = currentPollResult.ranks;
        const prevPoll = week > 0 ? extractPollRanks(rankingsRaw, week - 1).ranks : [];
        const prevRankOf = {};
        prevPoll.forEach(r => { prevRankOf[r.school] = r.rank; });

        const teamList = teamsInfo.filter(t => t.classification === "fbs").map(t => t.school);
        const priorWeeksGames = seasonGames.filter(g => g.week < week);
        const colley = colleyRatingsFull(priorWeeksGames, teamList);
        const colleyOrder = teamList.slice().sort((a, b) => {
          const ra = colley[a] ? colley[a].rating : 0;
          const rb = colley[b] ? colley[b].rating : 0;
          return rb - ra;
        });
        const colleyRankOf = {};
        colleyOrder.forEach((t, i) => { colleyRankOf[t] = i + 1; });

        const top25 = currentPoll.slice(0, 25).map(entry => {
          const school = entry.school;
          const teamGames = seasonGames.filter(g => g.homeTeam === school || g.awayTeam === school);
          const completed = teamGames
            .filter(g => g.week < week && g.homePoints !== null && g.homePoints !== undefined && g.awayPoints !== null && g.awayPoints !== undefined)
            .sort((a, b) => a.week - b.week);

          let wins = 0, losses = 0;
          completed.forEach(g => {
            const isHome = g.homeTeam === school;
            const teamScore = isHome ? g.homePoints : g.awayPoints;
            const oppScore = isHome ? g.awayPoints : g.homePoints;
            if (teamScore > oppScore) wins++; else losses++;
          });

          let lastGame = null;
          if (completed.length) {
            const g = completed[completed.length - 1];
            const isHome = g.homeTeam === school;
            const opp = isHome ? g.awayTeam : g.homeTeam;
            const teamScore = isHome ? g.homePoints : g.awayPoints;
            const oppScore = isHome ? g.awayPoints : g.homePoints;
            lastGame = { opp, result: teamScore > oppScore ? "beat" : "lost_to", teamScore, oppScore, link: watchLink(isHome ? school : opp, isHome ? opp : school, year) };
          }

          // Targets week+1 specifically -- matching exactly what the
          // "Next Week" schedule section shows below, rather than
          // picking up the CURRENT week's still-unplayed game (which
          // made the two sections visibly disagree with each other).
          const upcoming = teamGames
            .filter(g => g.week === week + 1)
            .sort((a, b) => a.week - b.week);
          let nextGame = null;
          if (upcoming.length) {
            const g = upcoming[0];
            const isHome = g.homeTeam === school;
            nextGame = { opp: isHome ? g.awayTeam : g.homeTeam, kickoffUTC: g.startDate, home: isHome };
          }

          const prevRank = prevRankOf[school];
          let trend;
          if (prevRank === undefined) trend = { direction: "new", delta: null };
          else if (prevRank === entry.rank) trend = { direction: "flat", delta: 0 };
          else trend = { direction: prevRank > entry.rank ? "up" : "down", delta: Math.abs(prevRank - entry.rank) };

          return {
            rank: entry.rank, school, wins, losses,
            trend, colleyRank: colleyRankOf[school] || null,
            lastGame, nextGame
          };
        });

        const top25Body = JSON.stringify({ year, week, pollSource: pollSource(week), top25, _dataWarning: currentPollResult.warning || undefined });
        const top25Response = new Response(top25Body, { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=10800" } });
        ctx.waitUntil(top25Cache.put(top25CacheKey, top25Response.clone()));
        return top25Response;
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: corsHeaders() });
      }
    }

    if (team && mode === "schedule") {
      // Full-season schedule mode: every game on this team's schedule
      // for the year, each flagged with the opponent's current rank
      // (if any), whether it's a known rivalry, and whether the line
      // makes it a close/toss-up game -- for a season-wide view, not
      // just the current week.
      const scheduleCacheKey = new Request(url.toString(), request);
      const scheduleCache = caches.default;
      const scheduleCached = await scheduleCache.match(scheduleCacheKey);
      if (scheduleCached) return scheduleCached;

      try {
        const [teamGames, teamLines, rankingsRaw] = await Promise.all([
          cfbdFetch(env, "/games", { year, team, seasonType: "regular" }),
          cfbdFetch(env, "/lines", { year, team, seasonType: "regular" }),
          cfbdFetch(env, "/rankings", { year, seasonType: "regular" })
        ]);

        const pollRanks = extractPollRanks(rankingsRaw, week).ranks;
        const rankedSet = {};
        pollRanks.forEach(r => { rankedSet[r.school] = r.rank; });
        const rivals = RIVALRIES[team] || [];

        const schedule = teamGames.map(g => {
          const isHome = g.homeTeam === team;
          const opp = isHome ? g.awayTeam : g.homeTeam;
          const oppRank = rankedSet[opp] ?? null;
          const lineEntry = (teamLines || []).find(l => l.id === g.id);
          let favoredTeam = null, winProb = null;
          if (lineEntry && lineEntry.lines && lineEntry.lines.length) {
            const spread = parseFloat(lineEntry.lines[0].spread);
            if (!isNaN(spread)) {
              favoredTeam = spread < 0 ? g.homeTeam : spread > 0 ? g.awayTeam : null;
              winProb = spreadToWinProb(spread);
            }
          }
          return {
            game_id: g.id, week: g.week, opp, home: isHome, oppRank,
            isRivalry: rivals.includes(opp),
            isCloseGame: winProb !== null && winProb <= 0.60, // favorite's win prob 50-60% (i.e. ~40-60% either way)
            favoredTeam, winProb,
            kickoffUTC: g.startDate, network: (g.venue && g.venue.tv) || null,
            home_score: g.homePoints ?? null, away_score: g.awayPoints ?? null,
            link: watchLink(g.homeTeam, g.awayTeam, year)
          };
        }).sort((a, b) => a.week - b.week);

        const scheduleBody = JSON.stringify({ team, year, schedule });
        const scheduleResponse = new Response(scheduleBody, { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=10800" } });
        ctx.waitUntil(scheduleCache.put(scheduleCacheKey, scheduleResponse.clone()));
        return scheduleResponse;
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: corsHeaders() });
      }
    }

    if (!team) {
      // National ranked-games mode: no specific team requested, so
      // return every game this week involving at least one ranked
      // team, chronologically -- for a national "who's playing who"
      // ticker that isn't tied to any one team's playoff path.
      const nationalCacheKey = new Request(url.toString(), request);
      const nationalCache = caches.default;
      const nationalCached = await nationalCache.match(nationalCacheKey);
      if (nationalCached) return nationalCached;

      try {
        const [weekGames, weekLines, rankingsRaw] = await Promise.all([
          cfbdFetch(env, "/games", { year, week, seasonType: "regular" }),
          cfbdFetch(env, "/lines", { year, week, seasonType: "regular" }),
          cfbdFetch(env, "/rankings", { year, seasonType: "regular" })
        ]);
        const pollRanks = extractPollRanks(rankingsRaw, week).ranks;
        const rankedSet = {};
        pollRanks.forEach(r => { rankedSet[r.school] = r.rank; });

        const games = weekGames
          .filter(g => (g.homeTeam in rankedSet) || (g.awayTeam in rankedSet))
          .map(g => {
            const homeRank = rankedSet[g.homeTeam] ?? null;
            const awayRank = rankedSet[g.awayTeam] ?? null;
            const lineEntry = (weekLines || []).find(l => l.id === g.id);
            let favoredTeam = null, winProb = null;
            if (lineEntry && lineEntry.lines && lineEntry.lines.length) {
              const spread = parseFloat(lineEntry.lines[0].spread);
              if (!isNaN(spread)) {
                favoredTeam = spread < 0 ? g.homeTeam : spread > 0 ? g.awayTeam : null;
                winProb = spreadToWinProb(spread);
              }
            }
            return {
              game_id: g.id, home: g.homeTeam, away: g.awayTeam, homeRank, awayRank,
              kickoffUTC: g.startDate, network: (g.venue && g.venue.tv) || null,
              favoredTeam, winProb,
              home_score: g.homePoints ?? null, away_score: g.awayPoints ?? null,
              link: watchLink(g.homeTeam, g.awayTeam, year)
            };
          })
          .sort((a, b) => new Date(a.kickoffUTC) - new Date(b.kickoffUTC));

        const nationalBody = JSON.stringify({ year, week, games, pollSource: pollSource(week) });
        const nationalResponse = new Response(nationalBody, { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=10800" } });
        ctx.waitUntil(nationalCache.put(nationalCacheKey, nationalResponse.clone()));
        return nationalResponse;
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: corsHeaders() });
      }
    }

    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const [weekGames, weekLines, rankingsRaw, seasonGames, teamsInfo, teamSeasonGames] = await Promise.all([
        cfbdFetch(env, "/games", { year, week, seasonType: "regular" }),
        cfbdFetch(env, "/lines", { year, week, seasonType: "regular" }),
        cfbdFetch(env, "/rankings", { year, seasonType: "regular" }),
        cfbdFetch(env, "/games", { year, seasonType: "regular" }), // full season, for games-played counts
        cfbdFetch(env, "/teams", { year }),
        cfbdFetch(env, "/games", { year, team, seasonType: "regular" })
      ]);

      const pollRanks = extractPollRanks(rankingsRaw, week).ranks;
      const teamList = teamsInfo.filter(t => t.classification === "fbs").map(t => t.school);
      const teamConferences = {};
      teamsInfo.forEach(t => { teamConferences[t.school] = t.conference; });

      // CONSISTENCY GUARANTEE — this is not a minor detail. The whole
      // scoring computation for week N must use only results from
      // weeks BEFORE week N, never week N's own results, even ones
      // already final by the time of the request. If Thursday's game
      // finishes and someone checks the site Friday morning, Saturday's
      // OTHER games must still show the exact same scores and order
      // they would have Tuesday — otherwise the app's own behavior
      // becomes an ambient spoiler channel: a sharp user notices "that
      // game jumped in importance overnight" and correctly infers a
      // big result happened, without ever seeing a score. Freezing the
      // Colley/resume inputs to strictly prior weeks is what prevents
      // that, and it's also why this response is cached hard (below)
      // rather than refreshed frequently — staying identical all week
      // is the point, not a caching shortcut.
      const priorWeeksGames = seasonGames.filter(g => g.week < week);
      const ratings = gamesPlayedCounts(priorWeeksGames, teamList);
      const resume = buildResume(team, teamSeasonGames.filter(g => g.week < week));

      // The site's "Last game" snapshot used to only check a tiny
      // hardcoded local list (which only ever had 2 teams in it), so
      // any real live team showed "no games played yet" regardless
      // of reality. Compute the real most recent completed game here
      // and send it along -- same shape the old static data used, so
      // the client's existing rendering logic just works unchanged.
      const completedPriorGames = teamSeasonGames
        .filter(g => g.week < week && g.homePoints !== null && g.homePoints !== undefined && g.awayPoints !== null && g.awayPoints !== undefined)
        .sort((a, b) => a.week - b.week);
      const mostRecent = completedPriorGames.length ? completedPriorGames[completedPriorGames.length - 1] : null;
      let lastGame = null;
      if (mostRecent) {
        const isHome = mostRecent.homeTeam.toLowerCase() === team.toLowerCase();
        const opp = isHome ? mostRecent.awayTeam : mostRecent.homeTeam;
        const teamScore = isHome ? mostRecent.homePoints : mostRecent.awayPoints;
        const oppScore = isHome ? mostRecent.awayPoints : mostRecent.homePoints;
        lastGame = { opp, result: teamScore > oppScore ? "beat" : "lost_to", teamScore, oppScore };
      }

      let body;
      const results = scoreWeekServerSide(team, year, week, weekGames, weekLines, pollRanks, teamConferences, ratings, resume);
      body = JSON.stringify({ team, week, pollSource: pollSource(week), results, lastGame });

      // Cached for a full day, not 5 minutes — since the computation
      // is now frozen to prior-week data only, recomputing more often
      // than this buys nothing (the answer is guaranteed identical
      // until next week) and just burns API quota. This length is a
      // caching choice, not a data-freshness one.
      const response = new Response(body, { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=10800" } });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: corsHeaders() });
    }
  }
};
