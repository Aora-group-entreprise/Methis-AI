import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createClient, type JwtPayload } from "@supabase/supabase-js";
import { FIX_RELEASE_DAYS, PLAN_LIMITS } from "./limits.js";

export type Plan = keyof typeof PLAN_LIMITS;

export interface Account {
  id: string;
  email: string;
  plan: Plan;
  createdAt: string;
  usage: { day: string; analyses: number; fixes: number };
  billingCycleStartedAt?: string;
  fixCycleKey?: string;
}

const dataFile = join(process.cwd(), "data", "methis-usage.json");
const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;


const accounts = new Map<string, Account>();
let loaded = false;

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(await readFile(dataFile, "utf8")) as Account[];
    for (const account of saved) accounts.set(account.id, account);
  } catch {
    // First run or a fresh deployment.
  }
}

async function save() {
  await mkdir(dirname(dataFile), { recursive: true });
  await writeFile(dataFile, JSON.stringify([...accounts.values()], null, 2), "utf8");
}

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function cycleStart(account: Account): Date {
  return account.plan === "pro" && account.billingCycleStartedAt
    ? new Date(account.billingCycleStartedAt)
    : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
}

function cycleKey(account: Account, now = new Date()): string {
  if (account.plan === "free") return now.toISOString().slice(0, 7);
  return cycleStart(account).toISOString().slice(0, 10);
}

function ensureCycles(account: Account) {
  const day = dayKey();
  if (account.usage.day !== day) {
    account.usage.day = day;
    account.usage.analyses = 0;
  }
  const key = cycleKey(account);
  if (account.fixCycleKey !== key) {
    account.fixCycleKey = key;
    account.usage.fixes = 0;
  }
}

function releasedFixes(account: Account, now = new Date()): number {
  ensureCycles(account);
  if (account.plan === "free") return 2;
  const elapsedDays = Math.floor((now.getTime() - cycleStart(account).getTime()) / 86400000);
  return FIX_RELEASE_DAYS.filter((day) => elapsedDays >= day).length * 2;
}

function supabaseForToken(token: string) {
  if (!supabaseUrl || !supabasePublishableKey) return null;
  return createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => token,
  });
}

/**
 * Verify a Supabase Auth access token with getClaims().
 * With asymmetric signing keys, Supabase verifies against cached JWKS locally,
 * avoiding a user lookup request for every Méthis API request.
 */
async function verifyAccessToken(token: string): Promise<JwtPayload | null> {
  if (!token) return null;
  const client = supabaseForToken(token);
  if (!client) return null;
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims) return null;
  const claims = data.claims;
  if (claims.aud !== "authenticated" || typeof claims.sub !== "string") return null;
  return claims;
}

export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export async function current(token: string | undefined): Promise<Account | null> {
  if (!token) return null;
  const claims = await verifyAccessToken(token);
  if (!claims) return null;

  await load();
  const id = claims.sub as string;
  let account = accounts.get(id);
  if (!account) {
    account = {
      id,
      email: typeof claims.email === "string" ? claims.email : "",
      plan: "free",
      createdAt: new Date().toISOString(),
      usage: { day: dayKey(), analyses: 0, fixes: 0 },
    };
    accounts.set(id, account);
    await save();
  } else {
    if (typeof claims.email === "string" && account.email !== claims.email) {
      account.email = claims.email;
      await save();
    }
    ensureCycles(account);
  }
  return account;
}

export async function consume(account: Account, kind: "analyses" | "fixes") {
  await load();
  ensureCycles(account);

  if (kind === "analyses") {
    const limit = PLAN_LIMITS[account.plan].analysesPerDay;
    if (account.usage.analyses >= limit) {
      throw new Error(`Daily analyses limit reached for the ${account.plan} plan.`);
    }
    account.usage.analyses++;
    await save();
    return { used: account.usage.analyses, limit, period: "day" as const };
  }

  const released = releasedFixes(account);
  const available = Math.max(0, released - account.usage.fixes);
  if (available <= 0) {
    throw new Error(
      account.plan === "pro"
        ? "No Fix credit is currently available. New credits unlock on billing-cycle days 1, 10 and 15."
        : "No Fix credit is currently available. Free includes 2 Fixes per month.",
    );
  }
  account.usage.fixes++;
  await save();
  return {
    used: account.usage.fixes,
    released,
    availableAfter: available - 1,
    limit: PLAN_LIMITS[account.plan].fixesPerMonth,
    period: "monthly" as const,
  };
}

export function planInfo() {
  return Object.entries(PLAN_LIMITS).map(([plan, value]) => ({
    plan,
    ...value,
    fixReleaseDays: plan === "pro" ? [...FIX_RELEASE_DAYS] : [0],
  }));
}

const GUEST_ACCOUNT: Account = {
  id: "guest",
  email: "",
  plan: "free",
  createdAt: new Date().toISOString(),
  usage: { day: dayKey(), analyses: 0, fixes: 0 },
};

export function guestAccount(): Account {
  const account: Account = GUEST_ACCOUNT;
    id: "guest",
    email: "",
    plan: "free",
    createdAt: "",
    usage: { day: dayKey(), analyses: 0, fixes: 0 },
  };
  ensureCycles(account);
  return account;
}

export function publicAccount(account: Account) {
  const released = releasedFixes(account);
  return {
    id: account.id,
    email: account.email,
    plan: account.plan,
    usage: {
      ...account.usage,
      fixesReleased: released,
      fixesAvailable: Math.max(0, released - account.usage.fixes),
    },
    limits: PLAN_LIMITS[account.plan],
    billingCycleStartedAt: account.billingCycleStartedAt ?? null,
    fixReleaseDays: account.plan === "pro" ? [...FIX_RELEASE_DAYS] : [0],
  };
}
