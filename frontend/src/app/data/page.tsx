"use client";

/**
 * Public leadership analytics dashboard at /data — NO password.
 *
 * Shows only aggregated stats + LLM-derived topic insights (no raw
 * transcripts, no IPs). Data is fetched from /api/data/stats (fast, local)
 * and /api/data/insights (LLM, cached). A manual refresh button can force a
 * fresh LLM pass.
 */

import { useCallback, useEffect, useState } from "react";

/* ----------------------------- types ----------------------------- */

interface Stats {
  generatedAt: number;
  totals: {
    visitors: number;
    allDevices: number;
    interactions: number;
    connections: number;
    messages: number;
    userMessages: number;
  };
  engagement: {
    engagedRate: number;
    avgSessionSec: number;
    medianSessionSec: number;
    avgUserMsgPerInteraction: number;
  };
  retention: {
    returningVisitors: number;
    returnRate: number;
    repeatVisitors: number;
    avgInteractionsPerVisitor: number;
    visitDaysDistribution: { days: number; visitors: number }[];
  };
  activity: { visitorsLast24h: number; visitorsLast7d: number; interactionsLast24h: number };
  trend: { date: string; interactions: number; visitors: number }[];
  hourHeatmap: number[][];
  durationBuckets: { label: string; count: number }[];
  devices: { label: string; count: number }[];
}

interface Insights {
  generatedAt: number;
  basedOnMessages: number;
  summary: string;
  topics: { name: string; count: number; keywords: string[]; examples: string[] }[];
  keywords: { term: string; weight: number }[];
  dropoff: { topic: string; note: string; returnedShare: number }[];
  degraded?: string;
}

/* --------------------------- utilities --------------------------- */

const PALETTE = [
  "#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6",
  "#8b5cf6", "#ef4444", "#14b8a6", "#f97316", "#06b6d4",
];

function fmtDuration(sec: number): string {
  if (!sec || sec < 1) return "0秒";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s}秒`;
  return `${m}分${s}秒`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function fmtTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

/* --------------------------- primitives -------------------------- */

function Card({ title, hint, children, className = "" }: {
  title?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-5 ${className}`}>
      {title && (
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
          {hint && <span className="text-xs text-slate-400">{hint}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

function Kpi({ label, value, sub, accent }: {
  label: string;
  value: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-5">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-bold tracking-tight" style={{ color: accent }}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

/* Donut: returning vs new visitors. */
function Donut({ returning, total }: { returning: number; total: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const frac = total ? returning / total : 0;
  const newcomers = total - returning;
  return (
    <div className="flex items-center gap-5">
      <svg width="140" height="140" viewBox="0 0 140 140" className="-rotate-90">
        <circle cx="70" cy="70" r={r} fill="none" stroke="#e2e8f0" strokeWidth="16" />
        <circle
          cx="70" cy="70" r={r} fill="none" stroke="#6366f1" strokeWidth="16"
          strokeDasharray={`${c * frac} ${c}`} strokeLinecap="round"
        />
        <text x="70" y="70" textAnchor="middle" dominantBaseline="central"
          className="rotate-90" style={{ transformOrigin: "70px 70px" }}
          fontSize="22" fontWeight="700" fill="#1e293b">
          {pct(frac)}
        </text>
      </svg>
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "#6366f1" }} />
          <span className="text-slate-600">回访访客</span>
          <span className="font-semibold text-slate-800">{returning}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "#e2e8f0" }} />
          <span className="text-slate-600">新访客</span>
          <span className="font-semibold text-slate-800">{newcomers}</span>
        </div>
      </div>
    </div>
  );
}

/* Horizontal bar list. */
function BarList({ data, color = "#6366f1", unit = "" }: {
  data: { label: string; count: number }[];
  color?: string;
  unit?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-3 text-sm">
          <div className="w-20 shrink-0 text-right text-slate-500">{d.label}</div>
          <div className="relative h-6 flex-1 rounded bg-slate-100">
            <div
              className="absolute inset-y-0 left-0 rounded"
              style={{ width: `${(d.count / max) * 100}%`, background: color }}
            />
          </div>
          <div className="w-14 shrink-0 text-slate-700 tabular-nums">{d.count}{unit}</div>
        </div>
      ))}
    </div>
  );
}

/* 30-day trend bars. */
function TrendChart({ trend }: { trend: Stats["trend"] }) {
  const max = Math.max(1, ...trend.map((t) => t.interactions));
  return (
    <div>
      <div className="flex h-40 items-end gap-[3px]">
        {trend.map((t) => (
          <div key={t.date} className="group relative flex-1">
            <div
              className="w-full rounded-t bg-indigo-400 transition-colors group-hover:bg-indigo-600"
              style={{ height: `${Math.max(2, (t.interactions / max) * 150)}px` }}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white group-hover:block">
              {t.date.slice(5)}：{t.interactions} 次互动 · {t.visitors} 访客
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs text-slate-400">
        <span>{trend[0]?.date.slice(5)}</span>
        <span>{trend[trend.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

/* 7x24 visit heatmap (Beijing time). Rows Mon..Sun. */
function Heatmap({ heat }: { heat: number[][] }) {
  const dowOrder = [1, 2, 3, 4, 5, 6, 0];
  const dowLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const max = Math.max(1, ...heat.flat());
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="flex">
          <div className="w-10 shrink-0" />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 text-center text-[9px] text-slate-400">
              {h % 3 === 0 ? h : ""}
            </div>
          ))}
        </div>
        {dowOrder.map((dow, i) => (
          <div key={dow} className="mt-[2px] flex items-center">
            <div className="w-10 shrink-0 text-xs text-slate-500">{dowLabels[i]}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const v = heat[dow]?.[h] ?? 0;
              const intensity = v / max;
              return (
                <div key={h} className="group relative flex-1 px-[1px]">
                  <div
                    className="h-5 rounded-sm"
                    style={{
                      background: v === 0 ? "#f1f5f9" : `rgba(99,102,241,${0.15 + intensity * 0.85})`,
                    }}
                  />
                  {v > 0 && (
                    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white group-hover:block">
                      {dowLabels[i]} {h}:00 · {v} 次
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-slate-400">
          <span>少</span>
          {[0.15, 0.4, 0.65, 0.9].map((o) => (
            <span key={o} className="h-3 w-3 rounded-sm" style={{ background: `rgba(99,102,241,${o})` }} />
          ))}
          <span>多</span>
        </div>
      </div>
    </div>
  );
}

/* Topic clusters as sized bubbles (the 聚类图). */
function ClusterBubbles({ topics }: { topics: Insights["topics"] }) {
  const max = Math.max(1, ...topics.map((t) => t.count));
  return (
    <div className="flex flex-wrap items-center justify-center gap-4 py-2">
      {topics.map((t, i) => {
        const size = 70 + Math.sqrt(t.count / max) * 90; // 70..160 px
        const color = PALETTE[i % PALETTE.length];
        return (
          <div
            key={t.name}
            className="group relative flex flex-col items-center justify-center rounded-full text-center text-white shadow-md transition-transform hover:scale-105"
            style={{ width: size, height: size, background: color }}
            title={t.examples.join(" / ")}
          >
            <span className="px-2 text-xs font-semibold leading-tight">{t.name}</span>
            <span className="text-[11px] opacity-90">{t.count}</span>
            {t.examples.length > 0 && (
              <div className="pointer-events-none absolute top-full left-1/2 z-10 mt-1 hidden w-48 -translate-x-1/2 rounded-lg bg-slate-800 px-3 py-2 text-left text-[11px] leading-snug text-white group-hover:block">
                <div className="mb-1 font-semibold">{t.keywords.join("、")}</div>
                {t.examples.map((e, j) => (
                  <div key={j} className="truncate">· {e}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* Word cloud: weight-scaled spans. */
function WordCloud({ keywords }: { keywords: Insights["keywords"] }) {
  const max = Math.max(1, ...keywords.map((k) => k.weight));
  const min = Math.min(...keywords.map((k) => k.weight));
  const sorted = [...keywords].sort((a, b) => b.weight - a.weight);
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 py-2">
      {sorted.map((k, i) => {
        const norm = max === min ? 0.5 : (k.weight - min) / (max - min);
        const fontSize = 13 + norm * 31; // 13..44 px
        const color = PALETTE[i % PALETTE.length];
        return (
          <span
            key={k.term}
            style={{ fontSize, color, fontWeight: 500 + Math.round(norm * 300) }}
            className="leading-none transition-opacity hover:opacity-70"
            title={`热度 ${k.weight}`}
          >
            {k.term}
          </span>
        );
      })}
    </div>
  );
}

/* --------------------------- main page --------------------------- */

export default function DataPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loadingInsights, setLoadingInsights] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const r = await fetch("/api/data/stats", { cache: "no-store" });
      if (!r.ok) throw new Error("stats " + r.status);
      setStats(await r.json());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const loadInsights = useCallback(async (force = false) => {
    setLoadingInsights(true);
    try {
      const r = await fetch(`/api/data/insights${force ? "?force=1" : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error("insights " + r.status);
      setInsights(await r.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingInsights(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
    loadInsights(false);
  }, [loadStats, loadInsights]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadStats(), loadInsights(true)]);
    setRefreshing(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-8">
        {/* header */}
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">小灵 · 数据看板</h1>
            <p className="mt-1 text-sm text-slate-500">
              陪伴机器人运营数据总览 · 访客行为与对话主题分析
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">
              数据更新于 {stats ? fmtTime(stats.generatedAt) : "…"}
            </span>
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {refreshing ? "刷新中…" : "刷新数据"}
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
            加载部分数据时出错：{error}
          </div>
        )}

        {!stats ? (
          <div className="py-20 text-center text-slate-400">加载中…</div>
        ) : (
          <div className="space-y-6">
            {/* KPI row */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Kpi
                label="累计访客（设备）"
                value={String(stats.totals.visitors)}
                sub={`近7天 ${stats.activity.visitorsLast7d} · 近24h ${stats.activity.visitorsLast24h}`}
                accent="#6366f1"
              />
              <Kpi
                label="回访率"
                value={pct(stats.retention.returnRate)}
                sub={`${stats.retention.returningVisitors} 人多日到访 · 人均 ${stats.retention.avgInteractionsPerVisitor.toFixed(1)} 次互动`}
                accent="#ec4899"
              />
              <Kpi
                label="平均互动时长"
                value={fmtDuration(stats.engagement.avgSessionSec)}
                sub={`中位 ${fmtDuration(stats.engagement.medianSessionSec)} · 人均 ${stats.engagement.avgUserMsgPerInteraction.toFixed(1)} 句`}
                accent="#10b981"
              />
              <Kpi
                label="累计互动次数"
                value={String(stats.totals.interactions)}
                sub={`开口率 ${pct(stats.engagement.engagedRate)} · 共 ${stats.totals.userMessages} 句用户发言`}
                accent="#f59e0b"
              />
            </div>

            {/* retention + trend */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <Card title="新访客 vs 回访客" hint="按访问天数判定">
                <Donut returning={stats.retention.returningVisitors} total={stats.totals.visitors} />
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <div className="mb-2 text-xs text-slate-500">到访天数分布</div>
                  <BarList
                    data={stats.retention.visitDaysDistribution.map((d) => ({
                      label: `${d.days} 天`,
                      count: d.visitors,
                    }))}
                    color="#ec4899"
                    unit=" 人"
                  />
                </div>
              </Card>
              <Card title="互动趋势（近30天）" hint="每日有效互动次数" className="lg:col-span-2">
                <TrendChart trend={stats.trend} />
              </Card>
            </div>

            {/* heatmap */}
            <Card title="访问时段热力图" hint="北京时间 · 颜色越深互动越多">
              <Heatmap heat={stats.hourHeatmap} />
            </Card>

            {/* duration + device */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card title="单次互动时长分布" hint="仅统计有对话的访问">
                <BarList data={stats.durationBuckets} color="#10b981" unit=" 次" />
              </Card>
              <Card title="访问设备分布" hint="按操作系统">
                {stats.devices.length ? (
                  <BarList data={stats.devices} color="#3b82f6" unit=" 次" />
                ) : (
                  <p className="text-sm text-slate-400">暂无设备数据</p>
                )}
              </Card>
            </div>

            {/* ----- LLM insights ----- */}
            <div className="flex items-center gap-3 pt-2">
              <h2 className="text-lg font-bold text-slate-800">对话内容分析</h2>
              <span className="text-xs text-slate-400">
                基于 AI 对 {insights?.basedOnMessages ?? "…"} 条用户语句的语义分析
              </span>
            </div>

            {insights?.degraded && (
              <div className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-700 ring-1 ring-amber-200">
                {insights.degraded}
              </div>
            )}

            <Card title="整体摘要">
              {loadingInsights && !insights ? (
                <p className="text-sm text-slate-400">AI 分析中，请稍候…</p>
              ) : (
                <p className="text-sm leading-relaxed text-slate-700">
                  {insights?.summary || "暂无摘要"}
                </p>
              )}
            </Card>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card title="对话主题聚类" hint="气泡越大该主题越热门">
                {insights?.topics.length ? (
                  <ClusterBubbles topics={insights.topics} />
                ) : (
                  <p className="py-8 text-center text-sm text-slate-400">
                    {loadingInsights ? "分析中…" : "暂无主题数据"}
                  </p>
                )}
              </Card>
              <Card title="主题词云" hint="字号越大热度越高">
                {insights?.keywords.length ? (
                  <WordCloud keywords={insights.keywords} />
                ) : (
                  <p className="py-8 text-center text-sm text-slate-400">
                    {loadingInsights ? "分析中…" : "暂无关键词"}
                  </p>
                )}
              </Card>
            </div>

            <Card title="流失话题分析" hint="用户结束对话时停留的话题（重点关注未再回访的用户）">
              {insights?.dropoff.length ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {insights.dropoff.map((d, i) => (
                    <div key={i} className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-800">{d.topic}</span>
                        <span
                          className="rounded-full px-2 py-0.5 text-xs font-medium"
                          style={{
                            background: d.returnedShare < 0.3 ? "#fee2e2" : "#dcfce7",
                            color: d.returnedShare < 0.3 ? "#b91c1c" : "#15803d",
                          }}
                        >
                          回访率 {pct(d.returnedShare)}
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-slate-500">{d.note}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-slate-400">
                  {loadingInsights ? "分析中…" : "暂无流失话题数据"}
                </p>
              )}
            </Card>

            <footer className="pb-8 pt-2 text-center text-xs text-slate-400">
              本看板仅展示聚合统计与 AI 摘要，不包含任何原始对话或个人身份信息。
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
