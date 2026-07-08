'use strict';
/*
 * portfolio.js — budget allocation across qualified opportunities (Option B).
 *
 * Never hides a stock. Ranks the qualified list by margin, then fills the daily
 * budget top-down: each stock is tagged TAKE (fits) or OVER-BUDGET (past the line).
 * The user still sees everything; this just guides "which ones fit my budget".
 *
 * rankBy (config.PORTFOLIO.rankBy):
 *   'est_profit_kd' (default) — net fils after commission × shares = KD you'd keep
 *   'net_fils'                — profit per share after commission
 *   'swing1_fils'             — raw swing size today
 */
function allocateBudget(opportunities, budgetKd, cfg = {}) {
  const rankBy = cfg.rankBy || 'est_profit_kd';
  const tradable = opportunities.filter((o) => o.size_tag === 'TRADABLE');
  const others = opportunities.filter((o) => o.size_tag !== 'TRADABLE'); // flagged ones never take budget

  const ranked = [...tradable].sort((a, b) => (b[rankBy] ?? 0) - (a[rankBy] ?? 0));
  let spent = 0;
  const out = ranked.map((o) => {
    const fits = budgetKd == null || spent + (o.kd_needed ?? 0) <= budgetKd;
    if (fits) spent += o.kd_needed ?? 0;
    return { ...o, allocation: fits ? 'TAKE' : 'OVER-BUDGET', running_kd: fits ? Math.round(spent) : null };
  });
  // flagged (too-expensive / over-risk / illiquid) stay visible, never allocated
  for (const o of others) out.push({ ...o, allocation: 'SKIP', running_kd: null });
  return { rankBy, budget: budgetKd, deployed: Math.round(spent), taken: out.filter((o) => o.allocation === 'TAKE').length, list: out };
}
module.exports = { allocateBudget };
