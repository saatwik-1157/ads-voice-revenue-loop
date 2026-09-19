import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Who is calling, and what they may do.
 *
 * Two roles rather than one token for everything, because the read surface and
 * the write surface carry very different risk: `GET /runs/:id` exposes
 * economics, recommendations and pending approvals, while `POST /leads` places
 * a phone call and `POST /revenue` moves money. Handing the same secret to a
 * dashboard and to whatever can dial a stranger makes the weaker use the one
 * that sets the blast radius.
 *
 * Deliberately small. This is token-to-role, not user accounts: there is one
 * operator and no session state. Roles are named rather than implied so that
 * adding OWNER/ANALYST later is a widening of this table, not a rewrite of
 * every route.
 */

export type Role = 'admin' | 'viewer';

export interface Principal {
  role: Role;
  /** How the caller identified themselves, for logs. Never the token itself. */
  via: string;
}

/** Roles that satisfy a requirement. Admin can do anything a viewer can. */
const SATISFIES: Record<Role, Role[]> = {
  viewer: ['viewer', 'admin'],
  admin: ['admin'],
};

/**
 * Constant-time comparison that cannot throw on a length mismatch.
 *
 * `"probé".length` is 5 just like `"probe"`, but the UTF-8 buffers differ in
 * length and timingSafeEqual throws on that - which turned a wrong token into
 * a 500 rather than a refusal.
 */
function tokenMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/**
 * Identify the caller, or return null.
 *
 * Fails closed in both directions: an unset secret authenticates nobody, and an
 * unrecognised token is simply not a principal. There is no anonymous role.
 */
export function identify(req: IncomingMessage): Principal | null {
  const adminToken = process.env.FL_ADMIN_TOKEN ?? '';
  const viewerToken = process.env.FL_VIEWER_TOKEN ?? '';

  const supplied =
    headerValue(req, 'x-fl-admin-token') ||
    headerValue(req, 'x-fl-token') ||
    headerValue(req, 'authorization').replace(/^Bearer\s+/i, '');
  if (!supplied) return null;

  // Admin first: if both variables are set to the same value, the stronger role
  // wins rather than the caller being silently downgraded.
  if (tokenMatches(supplied, adminToken)) return { role: 'admin', via: 'admin token' };
  if (tokenMatches(supplied, viewerToken)) return { role: 'viewer', via: 'viewer token' };
  return null;
}

export function permits(principal: Principal | null, required: Role): boolean {
  if (!principal) return false;
  return SATISFIES[required].includes(principal.role);
}

/** What to tell a caller who is refused, without hinting at what would work. */
export function refusalFor(required: Role): { status: number; body: { error: string } } {
  const variable = required === 'admin' ? 'FL_ADMIN_TOKEN' : 'FL_VIEWER_TOKEN (or FL_ADMIN_TOKEN)';
  return {
    status: 401,
    body: { error: `this route needs a ${required} token; set ${variable} and send it as x-fl-token` },
  };
}

/** True when nothing is configured, so `serve` can say so at startup. */
export function noTokensConfigured(): boolean {
  return !(process.env.FL_ADMIN_TOKEN ?? '') && !(process.env.FL_VIEWER_TOKEN ?? '');
}
