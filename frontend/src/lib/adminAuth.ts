/**
 * Shared admin Bearer-token check.
 *
 * The admin page stores the password in sessionStorage after the user
 * types it once, then sends it on every admin API call as
 *   Authorization: Bearer <ADMIN_TOKEN>
 * The server compares against process.env.ADMIN_TOKEN with a constant-time
 * compare to avoid trivial timing leaks. No cookies, no session table.
 */

import { timingSafeEqual } from "node:crypto";

export function checkAdminAuth(request: Request): { ok: true } | { ok: false; status: number; body: { error: string } } {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return { ok: false, status: 500, body: { error: "ADMIN_TOKEN not configured" } };
  }

  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, status: 401, body: { error: "Missing bearer token" } };
  }
  const provided = match[1].trim();

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, body: { error: "Invalid token" } };
  }
  return { ok: true };
}

export function getClientIp(request: Request): string | null {
  // Caddy sets X-Forwarded-For. Take the leftmost value (original client).
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xreal = request.headers.get("x-real-ip");
  if (xreal) return xreal.trim();
  return null;
}
