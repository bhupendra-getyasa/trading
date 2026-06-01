function extractUnit(value) {
  const match = value.trim().match(/[−-]?\d*\.?\d+\s*([A-Za-z]+)$/);
  return match ? match[1] : null;
}

module.exports = {
  extractUnit
};