/**
 * Pure-SQL analytics aggregations for the public /data dashboard.
 *
 * Everything here is derived from the existing sessions/messages tables —
 * no PII (raw transcripts, IP) is ever returned. Timestamps are bucketed
 * in Beijing time (UTC+8) so the "when do visitors come" charts read
 * correctly for the team.
 */

import { getDb } from "@/lib/db";

const DAY = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

/** Convert an epoch-ms timestamp into Beijing-local calendar parts. */
function beijingParts(ts: number) {
  const d = new Date(ts + BEIJING_OFFSET);
  return {
    // getUTC* because we already shifted into Beijing wall-clock.
    dateKey: d.toISOString().slice(0, 10), // YYYY-MM-DD
    hour: d.getUTCHours(), // 0-23
    dow: d.getUTCDay(), // 0=Sun .. 6=Sat
  };
}

interface SessionLite {
  id: string;
  user_id: string;
  started_at: number;
  last_seen: number;
  user_agent: string | null;
  msg_count: number;
  user_msg_count: number;
}

function parseDevice(ua: string | null): { kind: "mobile" | "desktop" | "unknown"; os: string } {
  if (!ua) return { kind: "unknown", os: "未知" };
  const u = ua.toLowerCase();
  const isMobile = /iphone|android|ipad|ipod|mobile|harmony/.test(u);
  let os = "其他";
  if (/iphone|ipad|ipod|ios/.test(u)) os = "iOS";
  else if (/android/.test(u)) os = "Android";
  else if (/harmony/.test(u)) os = "HarmonyOS";
  else if (/windows/.test(u)) os = "Windows";
  else if (/mac os|macintosh/.test(u)) os = "macOS";
  else if (/linux/.test(u)) os = "Linux";
  return { kind: isMobile ? "mobile" : "desktop", os };
}

/**
 * NOTE on "interactions" vs "connections": every WebSocket (re)connect writes
 * a fresh session row, so raw `sessions` is dominated by reconnect noise
 * (~10x the real number). All leadership-facing metrics below are built on
 * INTERACTIONS = sessions that contain at least one user utterance. Raw
 * connection count is exposed only as `totals.connections` for reference.
 */
export interface DashboardStats {
  generatedAt: number;
  totals: {
    visitors: number; // distinct devices that actually spoke (engaged)
    allDevices: number; // distinct devices incl. silent connects
    interactions: number; // sessions with >=1 user message (real "plays")
    connections: number; // raw session rows (reconnect-inflated, reference only)
    messages: number;
    userMessages: number;
  };
  engagement: {
    engagedRate: number; // engaged visitors / all devices that connected
    avgSessionSec: number; // mean duration over interactions
    medianSessionSec: number;
    avgUserMsgPerInteraction: number;
  };
  retention: {
    returningVisitors: number; // engaged devices active on >=2 distinct days
    returnRate: number; // returningVisitors / visitors
    repeatVisitors: number; // engaged devices with >=2 interactions
    avgInteractionsPerVisitor: number;
    visitDaysDistribution: { days: number; visitors: number }[]; // engaged devices by # distinct interaction days
  };
  activity: {
    visitorsLast24h: number; // engaged
    visitorsLast7d: number;
    interactionsLast24h: number;
  };
  trend: { date: string; interactions: number; visitors: number }[]; // last 30 days, Beijing
  hourHeatmap: number[][]; // [dow 0-6][hour 0-23] = interaction count
  durationBuckets: { label: string; count: number }[];
  devices: { label: string; count: number }[]; // OS breakdown of interactions
}

export function computeStats(): DashboardStats {
  const db = getDb();
  const now = Date.now();

  const sessions = db
    .prepare(
      `SELECT s.id, s.user_id, s.started_at, s.last_seen, s.user_agent,
              COUNT(m.id) AS msg_count,
              COALESCE(SUM(CASE WHEN m.role='user' THEN 1 ELSE 0 END),0) AS user_msg_count
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       GROUP BY s.id`
    )
    .all() as SessionLite[];

  const totalMessages = (db.prepare(`SELECT COUNT(*) n FROM messages`).get() as { n: number }).n;
  const totalUserMessages = (
    db.prepare(`SELECT COUNT(*) n FROM messages WHERE role='user'`).get() as { n: number }
  ).n;

  const allDeviceSet = new Set<string>();
  const interactions = sessions.filter((s) => s.user_msg_count > 0);

  // per-visitor aggregates (only ENGAGED interactions count toward these)
  const byVisitor = new Map<string, { dates: Set<string>; interactions: number }>();
  const trendMap = new Map<string, { interactions: number; visitors: Set<string> }>();
  const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  const durations: number[] = [];
  const deviceCount = new Map<string, number>();

  const cutoff30 = now - 30 * DAY;

  for (const s of sessions) {
    allDeviceSet.add(s.user_id);
    if (s.user_msg_count === 0) continue; // skip silent reconnects entirely

    const v = byVisitor.get(s.user_id) ?? { dates: new Set<string>(), interactions: 0 };
    const { dateKey, hour, dow } = beijingParts(s.started_at);
    v.dates.add(dateKey);
    v.interactions += 1;
    byVisitor.set(s.user_id, v);

    heat[dow][hour] += 1;

    if (s.started_at >= cutoff30) {
      const t = trendMap.get(dateKey) ?? { interactions: 0, visitors: new Set<string>() };
      t.interactions += 1;
      t.visitors.add(s.user_id);
      trendMap.set(dateKey, t);
    }

    const dur = Math.max(0, s.last_seen - s.started_at) / 1000;
    durations.push(dur);
    const dev = parseDevice(s.user_agent);
    deviceCount.set(dev.os, (deviceCount.get(dev.os) ?? 0) + 1);
  }

  durations.sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);
  const avgSessionSec = durations.length ? sum / durations.length : 0;
  const medianSessionSec = durations.length
    ? durations[Math.floor(durations.length / 2)]
    : 0;

  // retention (over engaged visitors)
  let returning = 0;
  let repeatVisitors = 0;
  const visitDaysDist = new Map<number, number>();
  for (const v of byVisitor.values()) {
    if (v.dates.size >= 2) returning += 1;
    if (v.interactions >= 2) repeatVisitors += 1;
    const d = v.dates.size;
    visitDaysDist.set(d, (visitDaysDist.get(d) ?? 0) + 1);
  }

  // trend last 30 days (fill gaps)
  const trend: DashboardStats["trend"] = [];
  for (let i = 29; i >= 0; i--) {
    const dk = beijingParts(now - i * DAY).dateKey;
    const t = trendMap.get(dk);
    trend.push({ date: dk, interactions: t?.interactions ?? 0, visitors: t?.visitors.size ?? 0 });
  }

  // duration buckets (over interactions)
  const bucketDefs: { label: string; max: number }[] = [
    { label: "<30秒", max: 30 },
    { label: "30秒-1分", max: 60 },
    { label: "1-3分", max: 180 },
    { label: "3-5分", max: 300 },
    { label: "5-10分", max: 600 },
    { label: ">10分", max: Infinity },
  ];
  const durationBuckets = bucketDefs.map((b) => ({ label: b.label, count: 0 }));
  for (const d of durations) {
    const idx = bucketDefs.findIndex((b) => d < b.max);
    durationBuckets[idx === -1 ? durationBuckets.length - 1 : idx].count += 1;
  }

  const visitorsLast24h = new Set(
    interactions.filter((s) => s.last_seen >= now - DAY).map((s) => s.user_id)
  ).size;
  const visitorsLast7d = new Set(
    interactions.filter((s) => s.last_seen >= now - 7 * DAY).map((s) => s.user_id)
  ).size;
  const interactionsLast24h = interactions.filter((s) => s.started_at >= now - DAY).length;

  const visitors = byVisitor.size; // engaged devices
  const allDevices = allDeviceSet.size;

  return {
    generatedAt: now,
    totals: {
      visitors,
      allDevices,
      interactions: interactions.length,
      connections: sessions.length,
      messages: totalMessages,
      userMessages: totalUserMessages,
    },
    engagement: {
      engagedRate: allDevices ? visitors / allDevices : 0,
      avgSessionSec,
      medianSessionSec,
      avgUserMsgPerInteraction: interactions.length
        ? interactions.reduce((a, s) => a + s.user_msg_count, 0) / interactions.length
        : 0,
    },
    retention: {
      returningVisitors: returning,
      returnRate: visitors ? returning / visitors : 0,
      repeatVisitors,
      avgInteractionsPerVisitor: visitors ? interactions.length / visitors : 0,
      visitDaysDistribution: [...visitDaysDist.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([days, v]) => ({ days, visitors: v })),
    },
    activity: { visitorsLast24h, visitorsLast7d, interactionsLast24h },
    trend,
    hourHeatmap: heat,
    durationBuckets,
    devices: [...deviceCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count })),
  };
}

export interface DropoffSample {
  content: string;
  returned: boolean;
}

/**
 * Pull the material the LLM needs for topic analysis:
 *  - userMessages: every user utterance (deduped, capped) for clustering + word cloud
 *  - dropoffLastMessages: the LAST user utterance of each session, tagged with
 *    whether that device ever came back afterwards. Feeds the "what topic made
 *    them leave" analysis.
 */
export function collectMessagesForLLM(maxMessages = 600): {
  userMessages: string[];
  dropoffLastMessages: DropoffSample[];
  totalUserMessages: number;
} {
  const db = getDb();

  const totalUserMessages = (
    db.prepare(`SELECT COUNT(*) n FROM messages WHERE role='user'`).get() as { n: number }
  ).n;

  const rawUser = db
    .prepare(
      `SELECT content FROM messages WHERE role='user'
       ORDER BY ts DESC LIMIT ?`
    )
    .all(maxMessages) as { content: string }[];

  // dedup while preserving order, drop trivial one-char filler
  const seen = new Set<string>();
  const userMessages: string[] = [];
  for (const r of rawUser) {
    const c = r.content.trim();
    if (!c || c.length < 2) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    userMessages.push(c);
  }

  // last user message per session
  const sessionRows = db
    .prepare(
      `SELECT s.id, s.user_id, s.last_seen FROM sessions s
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role='user')`
    )
    .all() as { id: string; user_id: string; last_seen: number }[];

  // map: latest session end per user (to decide "returned")
  const lastByUser = new Map<string, number>();
  for (const s of sessionRows) {
    lastByUser.set(s.user_id, Math.max(lastByUser.get(s.user_id) ?? 0, s.last_seen));
  }

  const lastMsgStmt = db.prepare(
    `SELECT content FROM messages WHERE session_id = ? AND role='user'
     ORDER BY ts DESC, id DESC LIMIT 1`
  );

  const dropoffLastMessages: DropoffSample[] = [];
  const dropSeen = new Set<string>();
  for (const s of sessionRows) {
    const row = lastMsgStmt.get(s.id) as { content: string } | undefined;
    if (!row) continue;
    const c = row.content.trim();
    if (!c || c.length < 2 || dropSeen.has(c)) continue;
    dropSeen.add(c);
    // returned = this device has a later session than this one's end
    const returned = (lastByUser.get(s.user_id) ?? 0) > s.last_seen + 1000;
    dropoffLastMessages.push({ content: c, returned });
  }

  return { userMessages, dropoffLastMessages, totalUserMessages };
}
