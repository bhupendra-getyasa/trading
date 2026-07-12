'use strict';
/* Processed-outcome vocabulary (recorded in radar_events + scanner_state). */
const OUTCOMES = { QUALIFIED: 'qualified', REJECTED: 'history_rejected', FAILED: 'history_failed', SKIPPED: 'user_skipped' };
function outcomeFor(v) { return v && v.qualifies ? OUTCOMES.QUALIFIED : OUTCOMES.REJECTED; }
module.exports = { OUTCOMES, outcomeFor };
