const { evaluateFormula } = require("./evaluateFormula.js");

/**
 * Runs all active formulas against a stock snapshot.
 *
 * BUG FIX: The original code had `if (!matched) continue` commented out,
 * which meant EVERY formula wrote its signal_output unconditionally,
 * regardless of whether the conditions were actually met.
 * The last formula for each indicator always "won", producing garbage signals.
 *
 * Now: only a formula whose conditions evaluate to TRUE sets the indicator.
 * Multiple formulas can target the same indicator (e.g. Bullish/Bearish Trend)
 * — the first matching one wins (sorted by priority ASC in loadFormulas).
 */
async function calculateIndicators(stock, formulas) {
  const indicators = {};

  for (const formula of formulas) {
    // Skip if this indicator has already been set by a higher-priority formula
    if (indicators[formula.indicator_name] !== undefined) continue;

    const matched = evaluateFormula(formula, formula.conditions, stock);

    if (matched) {
      indicators[formula.indicator_name] = formula.signal_output;
    }
  }

  return indicators;
}

module.exports = { calculateIndicators };
