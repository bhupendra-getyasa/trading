function parsePrice(value) {
  if (!value || value === "—") {
    return 0;
  }

  return parseFloat(
    value
      .replace(/,/g, "")
      .replace(/[A-Z]+/g, "")
      .trim()
  );
}

module.exports = {
  parsePrice
}