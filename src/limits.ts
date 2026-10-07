export const PLAN_LIMITS = {
  free: { analysesPerDay: 10, fixesPerDay: 0, githubFix: false },
  pro: { analysesPerDay: 100, fixesPerDay: 50, githubFix: true },
  team: { analysesPerDay: 500, fixesPerDay: 250, githubFix: true },
} as const;
