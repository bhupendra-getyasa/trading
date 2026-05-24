function parseMarketCap(value) {
  if (!value || value === "—") {
    return 0;
  }

  value = value.trim();

  const number = parseFloat(
    value.replace(/,/g, "")
  );

  if (value.includes("B")) {
    return number * 1_000_000_000;
  }

  if (value.includes("M")) {
    return number * 1_000_000;
  }

  return number;
}

module.exports = {
  parseMarketCap
}