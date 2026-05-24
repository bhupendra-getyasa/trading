const { operators } = require("./operators.js");
const { formulaFunctions } = require("./formulaFunctions.js");

function evaluateFormula(
  formula,
  conditions,
  stock
) {
  const results = [];

  for (const condition of conditions) {
    let leftValue =
      stock[condition.field_name];

    if (
      condition.function_name &&
      formulaFunctions[condition.function_name]
    ) {
      leftValue =
        formulaFunctions[
          condition.function_name
        ](leftValue);
    }

    let rightValue;

    // VALUE
    if (
      condition.compare_type === "VALUE"
    ) {
      rightValue = Number(
        condition.compare_value
      );
    }

    // FIELD
    if (
      condition.compare_type === "FIELD"
    ) {
      rightValue =
        stock[condition.compare_field];
    }

    // FIELD_MULTIPLIER
    if (
      condition.compare_type ===
      "FIELD_MULTIPLIER"
    ) {
      rightValue =
        stock[condition.compare_field] *
        Number(condition.compare_value);
    }

    const result =
      operators[condition.operator](
        leftValue,
        rightValue
      );

    results.push(result);
  }

  return formula.logical_join === "AND"
    ? results.every(Boolean)
    : results.some(Boolean);
}

module.exports = {
  evaluateFormula,
};