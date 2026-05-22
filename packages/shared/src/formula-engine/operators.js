const operators = {
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  "=": (a, b) => a == b,
  "!=": (a, b) => a != b,
};

module.exports = {
  operators,
};
