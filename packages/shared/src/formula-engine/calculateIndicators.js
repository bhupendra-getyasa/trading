const { evaluateFormula } = require("./evaluateFormula.js");

async function calculateIndicators(
  stock,
  formulas
) {

  const indicators = {};

  for (const formula of formulas) {

    const matched =
      evaluateFormula(
        formula,
        formula.conditions,
        stock
      );

    if (!matched) continue;

    indicators[
      formula.indicator_name
    ] =
      formula.signal_output;
  }

  return indicators;
}

module.exports = {
    calculateIndicators
}