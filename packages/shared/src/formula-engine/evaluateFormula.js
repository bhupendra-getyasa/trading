const { operators } = require("./operators.js");
const { formulaFunctions } = require("./formulaFunctions.js");

function evaluateFormula(formula, conditions, stock) {
  const results = [];

  for (const condition of conditions) {
    let leftValue = stock[condition.field_name];

    // Apply function
    if (condition.function_name) {
      const fn = formulaFunctions[condition.function_name];

      if (fn) {
        leftValue = fn(leftValue);
      }
    }

    let rightValue;

    // VALUE
    if (condition.compare_type === "VALUE") {
      rightValue = Number(condition.compare_value);
    }

    // FIELD
    if (condition.compare_type === "FIELD") {
      rightValue = stock[condition.compare_field];
    }

    // FIELD_MULTIPLIER
    if (condition.compare_type === "FIELD_MULTIPLIER") {
      rightValue =
        stock[condition.compare_field] *
        Number(condition.compare_value);
    }

    const operation = operators[condition.operator];

    const result = operation(leftValue, rightValue);

    results.push(result);
  }

  if (formula.logical_join === "AND") {
    return results.every(Boolean);
  }

  return results.some(Boolean);
}

module.exports = {
  evaluateFormula,
};