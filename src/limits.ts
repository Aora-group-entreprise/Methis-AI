export const FIX_RELEASE_DAYS = [0, 1, 10, 15] as const;

export const PLAN_LIMITS = {
  free: { analysesPerDay: 10, fixesPerMonth: 2, githubFix: true, price: "$0", currency: null },
  pro: { analysesPerDay: 100, fixesPerMonth: 8, githubFix: true, price: "$1", currency: "crypto" },
} as const;