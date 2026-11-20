"use client";

/**
 * Hidden admin dashboard at /admin.
 *
 * Auth: user types password into a form; we stash it in sessionStorage and
 * send it on every API call as `Authorization: Bearer <token>`. No cookies,
 * no server session — closing the tab logs out. The actual check happens
 * server-side in lib/adminAuth.ts.
 *
 * Layout: three panels —
 *   1. Top: aggregate counters (users / sessions / messages, plus 24h/7d activity)
 *   2. Left: user (device) list, click to drill in
 *   3. Right: that user's sessions, click to drill in
 *   4. Bottom: full transcript of the picked session
 */

import { useCallback, useEffect, useMemo, useState } from "react";

const TOKEN_KEY = "xiaoling_admin_token";

interface Stats {
  totalUsers: number;
  totalSessions: number;
  totalMessages: number;
  usersLast24h: number;
  usersLast7d: number;
  sessionsLast24h: number;
}

interface UserRow {
  user_id: string;
  first_seen: number;
  last_seen: number;
  session_count: number;
  message_count: number;
}

interface SessionRow {
  id: string;
  started_at: number;
  last_seen: number;
  user_agent: string | null;
  ip: string | null;
  message_count: number;
}

interface Message {
  id: number;
  ts: number;
  role: "user" | "assistant";
  content: string;
}

interface SessionDetail {
  session: SessionRow & { user_id: string };
  messages: Message[];
}

function fmtTs(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString();
}

function short(s: string, n = 12): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);

  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Boot: restore token from sessionStorage if present.
  useEffect(() => {
    const t = sessionStorage.getItem(TOKEN_KEY);
    if (t) setToken(t);
  }, []);

  const fetchJson = useCallback(
    async <T,>(path: string): Promise<T> => {
      const res = await fetch(path, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
        throw new Error("auth_expired");
      }
      if (!res.ok) throw new Error(`http_${res.status}`);
      return (await res.json()) as T;
    },
    [token],
  );

  // Initial dashboard load once authed.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [s, u] = await Promise.all([
          fetchJson<Stats>("/api/admin/stats"),
          fetchJson<{ users: UserRow[] }>("/api/admin/users"),
        ]);
        if (!cancelled) {
          setStats(s);
          setUsers(u.users);
        }
      } catch (e) {
        if (!cancelled) console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, fetchJson]);

  // Drill into a user.
  useEffect(() => {
    if (!token || !selectedUser) {
      setSessions(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchJson<{ sessions: SessionRow[] }>(
          `/api/admin/sessions?user_id=${encodeURIComponent(selectedUser)}`,
        );
        if (!cancelled) setSessions(d.sessions);
      } catch (e) {
        if (!cancelled) console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, selectedUser, fetchJson]);

  // Drill into a session.
  useEffect(() => {
    if (!token || !selectedSession) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchJson<SessionDetail>(
          `/api/admin/sessions/${encodeURIComponent(selectedSession)}`,
        );
        if (!cancelled) setDetail(d);
      } catch (e) {
        if (!cancelled) console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, selectedSession, fetchJson]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    // Probe a cheap endpoint to validate the password before persisting.
    try {
      const res = await fetch("/api/admin/stats", {
        headers: { Authorization: `Bearer ${passwordInput}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        setLoginError("密码错误");
        return;
      }
      if (!res.ok) {
        setLoginError(`服务器错误 (${res.status})`);
        return;
      }
      sessionStorage.setItem(TOKEN_KEY, passwordInput);
      setToken(passwordInput);
      setPasswordInput("");
    } catch {
      setLoginError("网络错误");
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setStats(null);
    setUsers(null);
    setSessions(null);
    setDetail(null);
    setSelectedUser(null);
    setSelectedSession(null);
  };

  if (!token) {
    return (
      <div style={loginWrap}>
        <form onSubmit={handleLogin} style={loginCard}>
          <h1 style={{ fontSize: 18, margin: 0, marginBottom: 16 }}>xiaoling · admin</h1>
          <input
            type="password"
            placeholder="管理员密码"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            autoFocus
            style={inputStyle}
          />
          {loginError && <div style={{ color: "#c33", fontSize: 13, marginTop: 8 }}>{loginError}</div>}
          <button type="submit" style={btnStyle}>
            进入
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={pageWrap}>
      <header style={headerStyle}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>xiaoling · admin</div>
        <button onClick={handleLogout} style={logoutBtn} type="button">
          退出
        </button>
      </header>

      <section style={statsRow}>
        <Stat label="总设备数" value={stats?.totalUsers} />
        <Stat label="总 session" value={stats?.totalSessions} />
        <Stat label="总消息条数" value={stats?.totalMessages} />
        <Stat label="24h 活跃设备" value={stats?.usersLast24h} />
        <Stat label="7d 活跃设备" value={stats?.usersLast7d} />
        <Stat label="24h 新 session" value={stats?.sessionsLast24h} />
      </section>

      <section style={threeCol}>
        {/* Users */}
        <div style={panel}>
          <div style={panelHead}>设备列表 {users && `(${users.length})`}</div>
          <div style={panelBody}>
            {loading && !users && <div style={muted}>加载中…</div>}
            {users?.length === 0 && <div style={muted}>暂无数据</div>}
            {users?.map((u) => (
              <button
                key={u.user_id}
                type="button"
                onClick={() => {
                  setSelectedUser(u.user_id);
                  setSelectedSession(null);
                }}
                style={{
                  ...rowBtn,
                  background: selectedUser === u.user_id ? "#eef4ff" : "transparent",
                }}
              >
                <div style={{ fontFamily: "monospace", fontSize: 12 }}>{short(u.user_id, 18)}</div>
                <div style={{ fontSize: 11, color: "#666" }}>
                  {u.session_count} session · {u.message_count} 条消息
                </div>
                <div style={{ fontSize: 11, color: "#999" }}>最近：{fmtTs(u.last_seen)}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Sessions */}
        <div style={panel}>
          <div style={panelHead}>
            该设备的 session {sessions && `(${sessions.length})`}
          </div>
          <div style={panelBody}>
            {!selectedUser && <div style={muted}>← 选一个设备</div>}
            {selectedUser && !sessions && <div style={muted}>加载中…</div>}
            {sessions?.length === 0 && <div style={muted}>无 session</div>}
            {sessions?.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedSession(s.id)}
                style={{
                  ...rowBtn,
                  background: selectedSession === s.id ? "#eef4ff" : "transparent",
                }}
              >
                <div style={{ fontFamily: "monospace", fontSize: 11 }}>{short(s.id, 14)}</div>
                <div style={{ fontSize: 11, color: "#666" }}>{s.message_count} 条消息</div>
                <div style={{ fontSize: 11, color: "#999" }}>{fmtTs(s.started_at)}</div>
                {s.ip && <div style={{ fontSize: 10, color: "#aaa" }}>{s.ip}</div>}
              </button>
            ))}
          </div>
        </div>

        {/* Transcript */}
        <div style={{ ...panel, gridColumn: "span 1" }}>
          <div style={panelHead}>对话内容</div>
          <div style={panelBody}>
            {!selectedSession && <div style={muted}>← 选一个 session</div>}
            {selectedSession && !detail && <div style={muted}>加载中…</div>}
            {detail && (
              <>
                <div style={{ marginBottom: 12, fontSize: 11, color: "#666" }}>
                  <div>session: <code>{detail.session.id}</code></div>
                  <div>UA: {detail.session.user_agent || "—"}</div>
                </div>
                {detail.messages.length === 0 && <div style={muted}>（这个 session 没有消息）</div>}
                {detail.messages.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      marginBottom: 10,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: m.role === "user" ? "#f0f7ff" : "#f6f6f6",
                      borderLeft: `3px solid ${m.role === "user" ? "#4a8cff" : "#bbb"}`,
                    }}
                  >
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 2 }}>
                      {m.role === "user" ? "用户" : "助手"} · {fmtTs(m.ts)}
                    </div>
                    <div style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{m.content}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div style={statCard}>
      <div style={{ fontSize: 24, fontWeight: 600 }}>{value ?? "—"}</div>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
    </div>
  );
}

// --- styles (inline, keeps this page self-contained / no Tailwind class deps) ---

// NOTE on color: the root <html> has className="dark" (set in
// app/layout.tsx for the main chat UI), which makes body text near-white.
// Every container below sets an explicit color so the admin page reads
// as a normal light-theme page regardless of the global dark class.
const loginWrap: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#fafafa",
  color: "#111",
};
const loginCard: React.CSSProperties = {
  background: "#fff",
  padding: 24,
  borderRadius: 12,
  boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
  width: 320,
  display: "flex",
  flexDirection: "column",
  color: "#111",
};
const inputStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #ddd",
  fontSize: 14,
  color: "#111",
  background: "#fff",
};
const btnStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  borderRadius: 8,
  border: "none",
  background: "#111",
  color: "#fff",
  fontSize: 14,
  cursor: "pointer",
};
const pageWrap: React.CSSProperties = {
  padding: 20,
  background: "#fafafa",
  minHeight: "100vh",
  color: "#111",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 16,
};
const logoutBtn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid #ddd",
  background: "#fff",
  fontSize: 12,
  cursor: "pointer",
};
const statsRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(6, 1fr)",
  gap: 12,
  marginBottom: 16,
};
const statCard: React.CSSProperties = {
  background: "#fff",
  padding: 16,
  borderRadius: 10,
  border: "1px solid #eee",
  color: "#111",
};
const threeCol: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px 280px 1fr",
  gap: 12,
  height: "calc(100vh - 220px)",
};
const panel: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #eee",
  borderRadius: 10,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  color: "#111",
};
const panelHead: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 12,
  fontWeight: 600,
  borderBottom: "1px solid #eee",
  background: "#fafafa",
  color: "#111",
};
const panelBody: React.CSSProperties = {
  padding: 8,
  overflowY: "auto",
  flex: 1,
};
const rowBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  border: "none",
  padding: "8px 10px",
  marginBottom: 4,
  borderRadius: 6,
  cursor: "pointer",
  background: "transparent",
  color: "#111",
};
const muted: React.CSSProperties = {
  color: "#999",
  fontSize: 12,
  padding: 8,
};
