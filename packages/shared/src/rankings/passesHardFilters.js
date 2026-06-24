// passesHardFilters.js
// 
// All stocks are now included in the top performers list.
// The AI score communicates opportunity level — no stocks are hard-excluded.
// This file is kept for backwards compatibility only.

function passesHardFilters(stock) {
  return { passes: true, reason: null };
}

module.exports = { passesHardFilters };
