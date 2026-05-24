function parsePercent(value) {
  if (!value || value === "—") {
    return 0;
  }

  return parseFloat(
    value
      .replace("%", "")
      .replace("−", "-")
      .trim()
  );
}

module.exports = {
  parsePercent
}