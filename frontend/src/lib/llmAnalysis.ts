/**
 * LLM-powered semantic analysis for the /data dashboard.
 *
 * One batched call to the gpt.ge gateway over the corpus of user utterances
 * produces: an overall summary, topic clusters (the "聚类图"), weighted
 * keywords (the word cloud), and a drop-off analysis (what topics people
 * were on when they stopped / didn't return).
 *
 * Result is cached on disk (data/insights_cache.json). We regenerate when the
 * cache is older than TTL_MS or the underlying user-message count has moved
 * meaningfully — matching the "compute on page load + short cache" model so a
 * burst of leadership page-loads costs at most one gateway call.
 */

import path from "node:path";
import fs from "node:fs";
import { collectMessagesForLLM } from "@/lib/analytics";

const CACHE_PATH = path.join(process.cwd(), "data", "insights_cache.json");
const TTL_MS = 10 * 60 * 1000; // 10 minutes
const COUNT_DRIFT = 10; // regenerate if user-message count moved by >= this

export interface TopicCluster {
  name: string;
  count: number; // approximate number of utterances in this cluster
  keywords: string[];
  examples: string[];
}

export interface KeywordWeight {
  term: string;
  weight: number; // 1-100 relative
}

export interface DropoffTopic {
  topic: string;
  note: string; // why this likely caused drop-off / what it signals
  returnedShare: number; // 0-1: of users who ended on this topic, fraction who came back
}

export interface Insights {
  generatedAt: number;
  basedOnMessages: number;
  summary: string;
  topics: TopicCluster[];
  keywords: KeywordWeight[];
  dropoff: DropoffTopic[];
  degraded?: string; // set when LLM unavailable and we returned a minimal fallback
}

interface CacheFile {
  basedOnMessages: number;
  insights: Insights;
}

function readCache(): CacheFile | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

function writeCache(c: CacheFile) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(c), "utf8");
  } catch (err) {
    console.error("insights cache write failed", err);
  }
}

const SYSTEM_PROMPT = `你是一位中文对话数据分析师。你将收到一个陪伴型语音机器人"小灵"的真实用户语句样本。请做主题聚类与洞察分析，并严格输出 JSON（不要任何额外文字、不要markdown代码块）。

输出 JSON 结构：
{
  "summary": "一段150字以内的整体概述：用户主要在聊什么、整体使用画像、值得管理层关注的发现",
  "topics": [
    {"name":"主题名(简短中文)","count":该主题大致语句数(整数),"keywords":["词1","词2","词3"],"examples":["代表性原句1","原句2"]}
  ],
  "keywords": [
    {"term":"词云用词(中文名词/动词为主,去除停用词)","weight":1到100的相对热度整数}
  ],
  "dropoff": [
    {"topic":"用户最后停留并离开时的话题","note":"为何可能导致流失或说明了什么(简短)","returnedShare":0到1之间小数}
  ]
}

要求：
- topics 输出 6 到 9 个，按 count 降序，count 之和应接近样本总数。
- keywords 输出 25 到 40 个，权重体现真实热度差异。
- dropoff 基于"会话最后一句"样本分析，重点关注那些之后没有再回来的用户的话题，输出 4 到 6 个。
- 全部使用简体中文。仅输出 JSON。`;

function buildUserPrompt(
  userMessages: string[],
  dropoff: { content: string; returned: boolean }[]
): string {
  const msgs = userMessages.slice(0, 600);
  const drops = dropoff.slice(0, 200);
  return [
    `【全部用户语句样本，共 ${msgs.length} 条】`,
    msgs.map((m, i) => `${i + 1}. ${m}`).join("\n"),
    "",
    `【会话最后一句样本，共 ${drops.length} 条，标注用户之后是否再次回来】`,
    drops.map((d, i) => `${i + 1}. [${d.returned ? "回来了" : "没回来"}] ${d.content}`).join("\n"),
  ].join("\n");
}

async function callGateway(userPrompt: string): Promise<string> {
  const url = (process.env.LLM_GATEWAY_URL || "https://api.gpt.ge/v1").replace(/\/$/, "");
  const key = process.env.LLM_GATEWAY_KEY;
  const model = process.env.LLM_ANALYSIS_MODEL || "gpt-4o-mini";
  if (!key) throw new Error("LLM_GATEWAY_KEY not configured");

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`gateway ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("gateway returned empty content");
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function parseInsights(raw: string): Omit<Insights, "generatedAt" | "basedOnMessages"> {
  // tolerate accidental code fences
  let txt = raw.trim();
  if (txt.startsWith("```")) txt = txt.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  const obj = JSON.parse(txt) as Record<string, unknown>;

  const topics = Array.isArray(obj.topics)
    ? (obj.topics as Record<string, unknown>[]).map((t) => ({
        name: String(t.name ?? "未命名"),
        count: Math.max(0, Math.round(Number(t.count) || 0)),
        keywords: Array.isArray(t.keywords) ? (t.keywords as unknown[]).map(String).slice(0, 8) : [],
        examples: Array.isArray(t.examples) ? (t.examples as unknown[]).map(String).slice(0, 4) : [],
      }))
    : [];

  const keywords = Array.isArray(obj.keywords)
    ? (obj.keywords as Record<string, unknown>[])
        .map((k) => ({
          term: String(k.term ?? "").trim(),
          weight: Math.min(100, Math.max(1, Math.round(Number(k.weight) || 1))),
        }))
        .filter((k) => k.term)
    : [];

  const dropoff = Array.isArray(obj.dropoff)
    ? (obj.dropoff as Record<string, unknown>[]).map((d) => ({
        topic: String(d.topic ?? ""),
        note: String(d.note ?? ""),
        returnedShare: Math.min(1, Math.max(0, Number(d.returnedShare) || 0)),
      }))
    : [];

  return {
    summary: String(obj.summary ?? ""),
    topics: topics.sort((a, b) => b.count - a.count),
    keywords,
    dropoff,
  };
}

export async function getInsights(force = false): Promise<Insights> {
  const { userMessages, dropoffLastMessages, totalUserMessages } = collectMessagesForLLM();

  const cache = readCache();
  if (!force && cache) {
    const fresh = Date.now() - cache.insights.generatedAt < TTL_MS;
    const stable = Math.abs(cache.basedOnMessages - totalUserMessages) < COUNT_DRIFT;
    if (fresh && stable && !cache.insights.degraded) return cache.insights;
  }

  if (userMessages.length === 0) {
    return {
      generatedAt: Date.now(),
      basedOnMessages: 0,
      summary: "暂无足够的对话数据用于分析。",
      topics: [],
      keywords: [],
      dropoff: [],
    };
  }

  try {
    const raw = await callGateway(buildUserPrompt(userMessages, dropoffLastMessages));
    const parsed = parseInsights(raw);
    const insights: Insights = {
      generatedAt: Date.now(),
      basedOnMessages: totalUserMessages,
      ...parsed,
    };
    writeCache({ basedOnMessages: totalUserMessages, insights });
    return insights;
  } catch (err) {
    console.error("getInsights failed", err);
    // serve stale cache if we have one, else a degraded marker
    if (cache) return { ...cache.insights, degraded: "使用上次缓存结果（本次分析调用失败）" };
    return {
      generatedAt: Date.now(),
      basedOnMessages: totalUserMessages,
      summary: "分析服务暂时不可用，请稍后刷新重试。",
      topics: [],
      keywords: [],
      dropoff: [],
      degraded: String(err instanceof Error ? err.message : err),
    };
  }
}
