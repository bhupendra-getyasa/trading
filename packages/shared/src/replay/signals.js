'use strict';
/*
 * signals.js — entry-signal generation for replay, using the REAL live-engine swing
 * detector so the two entry models are compared on identical structure detection.
 *
 * Two models, same swing math, different moment:
 *   confirmation — fire when swings.secondSwingStarting is true (what ships today).
 *                  Price has already turned up, so we buy above the pullback low.
 *   zone         — fire while swings.pullbackHeldFib is true and price is still inside
 *                  the fib band. Better price; accepts that the pullback may continue.
 *
 * Both are gated afterwards by canEnter(), so the anti-chase, cooldown, ban and
 * liquidity rules apply identically. The ONLY variable is when the signal fires.
 */
const { detectSwings } = require('../live-engine/swings');
const LIVE = require('../live-engine/config');
const R = require('../tmi/rules');

function swingsFor(rows, windowN) {
  const w = rows.slice(-windowN).map((r) => ({ price: r.price, ts: r.ts }));
  return detectSwings(w, LIVE.SWING);
}

/*
 * qualified(sym) — history gate, known BEFORE the radar fires.
 * The radar_events row only appears at confirmation time, so zone entry (which fires
 * earlier) cannot wait for it. Classification is computed pre-open, so it is legitimately
 * available at any minute — this is not look-ahead.
 */
function qualified(s) {
  return !!(s.cls && LIVE.HISTORY.qualifyLanes.includes(s.cls.lane));
}

function attach(frame, session, state, cfg) {
  const windowN = LIVE.WINDOW.snapshots;
  for (const [sym, f] of Object.entries(frame.symbols)) {
    const s = session.symbols[sym];
    f.radarQualified = qualified(s);
    if (!f.radarQualified) continue;

    const rows = s.rows.filter((r) => r.minute <= frame.minute && r.price > 0);
    if (rows.length < 5) continue;
    const sw = swingsFor(rows, windowN);
    if (!sw.fib) continue;

    // swing-size band + opening exclusion, both applied to whichever model is active
    const s1 = sw.swing1Fils ?? 0;
    if (cfg.ENTRY.minSwing1Fils && s1 < cfg.ENTRY.minSwing1Fils) continue;
    if (cfg.ENTRY.maxSwing1Fils && s1 > cfg.ENTRY.maxSwing1Fils) continue;
    if (cfg.SELECTION.noTradeBeforeMinute && frame.minute < cfg.SELECTION.noTradeBeforeMinute) continue;

    if (cfg.ENTRY.model === 'zone') {
      // inside the pullback band, setup still alive, not yet confirmed
      const inZone = f.price >= sw.fib.zoneLow && f.price <= sw.fib.zoneHigh;
      if (sw.pullbackHeldFib && inZone) {
        f.entrySignal = true;
        f.entryPrice = f.price;
        f.entryReason = `zone ${Math.round(sw.fib.zoneLow)}-${Math.round(sw.fib.zoneHigh)} (swing1 ${sw.swing1Fils}f)`;
      }
    } else {
      if (sw.secondSwingStarting) {
        const zoneTop = sw.fib.zoneHigh;
        // same chase guard the live radar applies
        if (f.price <= zoneTop + (LIVE.SWING.entryTolFils ?? 2)) {
          f.entrySignal = true;
          f.entryPrice = f.price;
          f.entryReason = `2nd swing (swing1 ${sw.swing1Fils}f)`;
        }
      }
    }
  }
  return frame;
}

module.exports = { attach, swingsFor, qualified };
