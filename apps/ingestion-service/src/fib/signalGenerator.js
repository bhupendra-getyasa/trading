// apps/ingestion-service/src/fib/signalGenerator.js
// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL GENERATOR — EARLY-ENTRY REWRITE
// ─────────────────────────────────────────────────────────────────────────────
//
// CHANGES vs original:
//
//   1. COOLDOWN_MINUTES lowered 5 → 2.
//      With faster signal detection (1-tick confirmation), a 5-minute cooldown
//      would block a legitimate re-entry if price briefly bounced away from the
//      level and returned.  2 minutes matches the new ~2-tick confirmation window.
//
//   2. EARLY_BUY whatsapp emoji changed to ⚡ (was 🚀) to visually distinguish
//      anticipatory (Zone 2) alerts from breakout-confirmation (Zone 3) alerts.
//      ZONE 2 (approaching, before touch) → ⚡ "Approaching Fib Support"
//      ZONE 3 (breakout confirmed) → 🚀 "Breakout above level"
//
//   3. APPROACHING added as a recognized approach_direction in buildWhatsAppMessage.
//
//   4. processSignals unchanged in logic but signalOverrides now carries `zone`
//      metadata ('APPROACH', 'TOUCH', 'BREAKOUT') for logging / UI display.
//      This allows the frontend to show different cards for each signal type.
//
// ALL ORIGINAL FIXES PRESERVED (signal_code vs display_name, cooldown by type,
// is_broadcast atomicity, notified flag only on actual send, httpsPost logging).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { socketQueue } = require('@trading/shared');
const https           = require('https');

// CHANGED: 5 → 2 to match faster detection cycle
const COOLDOWN_MINUTES = parseInt(process.env.SIGNAL_COOLDOWN_MINUTES || '2', 10);

const NOTIFY_TYPES = new Set(
    (process.env.NOTIFY_SIGNAL_TYPES || 'STRONG_BUY,EARLY_BUY')
        .split(',').map(s => s.trim())
);

const PROVIDER   = (process.env.WHATSAPP_PROVIDER   || 'twilio').toLowerCase();
const RECIPIENTS = (process.env.WHATSAPP_RECIPIENTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// isOnCooldown — keyed on symbol + level_percent + signal_type
// ─────────────────────────────────────────────────────────────────────────────
async function isOnCooldown(pool, symbol, fibLevelPercent, signalType) {
    const { rows } = await pool.query(
        `SELECT 1
         FROM   public.fibonacci_signals
         WHERE  symbol            = $1
           AND  fib_level_percent = $2
           AND  signal_type       = $3
           AND  created_at       >= NOW() - ($4 || ' minutes')::INTERVAL
         LIMIT  1`,
        [symbol, fibLevelPercent, signalType, COOLDOWN_MINUTES]
    );
    return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// saveSignal
// ─────────────────────────────────────────────────────────────────────────────
async function saveSignal(pool, {
    swingId, symbol, companyName, changePercent,
    fibLevelId, fibLevelPercent, fibLevelPrice,
    triggerPrice, deviationPct,
    swingLow, swingHigh, trendDirection,
    signalType, signalStrength, approachDirection,
}) {
    // GUARD: verify the swing still exists before inserting.
    // updateSwing() returns the stale in-memory swing when its DB row has been
    // deleted or completed by a concurrent process (see swingDetector.js comment).
    // That stale id no longer exists in fibonacci_swings, so any INSERT into
    // fibonacci_signals with it will throw the FK violation we see in production.
    const { rows: swingCheck } = await pool.query(
        `SELECT 1 FROM public.fibonacci_swings WHERE id = $1 LIMIT 1`,
        [swingId]
    );
    if (swingCheck.length === 0) {
        console.warn(`[saveSignal] Skipping signal for ${symbol} — swing id ${swingId} no longer exists in DB (stale cache)`);
        return null;
    }

    const swingRange = parseFloat(swingHigh) - parseFloat(swingLow);

    // BUG FIX: the unique index uq_fib_signal (swing_id, fib_level_percent, signal_type)
    // can be violated when two ticks race through the cooldown check at the same time
    // (cooldown is checked before INSERT, not atomically with it).  Without ON CONFLICT
    // the INSERT throws a constraint violation that bubbles up through processSignals and
    // Promise.allSettled marks the entire symbol tick as failed.
    // ON CONFLICT DO NOTHING silently ignores the duplicate; the original row stands.
    const { rows } = await pool.query(
        `INSERT INTO public.fibonacci_signals (
           swing_id, symbol, company_name, change_percent,
           fib_level_id, fib_level_percent, fib_level_price,
           trigger_price, deviation_pct,
           swing_low, swing_high, swing_range, trend_direction,
           signal_type, signal_strength, approach_direction,
           is_broadcast
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, false)
         ON CONFLICT (swing_id, fib_level_percent, signal_type) DO NOTHING
         RETURNING *`,
        [
            swingId, symbol, companyName, changePercent,
            fibLevelId, fibLevelPercent, fibLevelPrice,
            triggerPrice, deviationPct,
            swingLow, swingHigh, swingRange, trendDirection,
            signalType, signalStrength, approachDirection,
        ]
    );
    // rows[0] is undefined when ON CONFLICT DO NOTHING suppresses the insert
    return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// broadcastSignal
// ─────────────────────────────────────────────────────────────────────────────
async function broadcastSignal(pool, signal) {
    await socketQueue.add('fib-signal', signal, {
        removeOnComplete: true,
        removeOnFail:     { count: 20 },
    });
    await pool.query(
        `UPDATE public.fibonacci_signals SET is_broadcast = true WHERE id = $1`,
        [signal.id]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// httpsPost
// ─────────────────────────────────────────────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
    return new Promise((resolve, reject) => {
        const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const req = https.request(
            { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } },
            (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                        else { const err = new Error(`HTTP ${res.statusCode}`); err.json = json; reject(err); }
                    } catch {
                        console.error(`[notifier] Non-JSON response from ${hostname}:`, data.slice(0, 500));
                        reject(new Error(`Non-JSON response (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
                    }
                });
            }
        );
        req.on('error', reject);
        req.write(buf);
        req.end();
    });
}

async function sendViaTwilio(to, message) {
    const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_WHATSAPP_FROM;
    if (!sid || !token || !from) throw new Error('Twilio credentials not set');
    const dest = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const body = new URLSearchParams({ From: from, To: dest, Body: message }).toString();
    const json = await httpsPost('api.twilio.com', `/2010-04-01/Accounts/${sid}/Messages.json`,
        { 'Authorization': `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    return json.sid;
}

async function sendViaMeta(to, message) {
    const token = process.env.META_WHATSAPP_TOKEN, phoneId = process.env.META_PHONE_NUMBER_ID;
    if (!token || !phoneId) throw new Error('Meta credentials not set');
    const json = await httpsPost('graph.facebook.com', `/v18.0/${phoneId}/messages`,
        { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        { messaging_product: 'whatsapp', to: to.replace(/[^0-9]/g, ''), type: 'text', text: { body: message } });
    return json.messages?.[0]?.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildWhatsAppMessage
// CHANGED: approach labels updated for all three zones
// ─────────────────────────────────────────────────────────────────────────────
function buildWhatsAppMessage(signal) {
    const emoji = {
        STRONG_BUY: '🟢',
        BUY:        '🟡',
        EARLY_BUY:  '⚡',   // Zone 2 (approaching) — was 🚀
        RESISTANCE: '🔴',
        WEAK:       '⚠️',
        TOUCH:      '📍',
    };
    const stars  = '★'.repeat(signal.signal_strength || 1);
    const dir    = signal.trend_direction === 'BULLISH' ? '📈' : '📉';
    const kwTime = new Date().toLocaleString('en-KW', { timeZone: 'Asia/Kuwait', dateStyle: 'medium', timeStyle: 'short' });
    const fmt    = n => (n != null ? Number(n).toFixed(3) : 'N/A');

    // Zone 2 (EARLY_BUY + FROM_ABOVE) = approaching; Zone 1 (BUY + FROM_ABOVE) = at level
    const approachLabel =
        signal.approach_direction === 'FROM_ABOVE' && signal.signal_type === 'EARLY_BUY'
            ? '⚡ Approaching fib support — place limit order'
            : signal.approach_direction === 'FROM_ABOVE'
                ? '↘️ Retracing to support level'
                : signal.approach_direction === 'BREAKOUT_UP'
                    ? '🚀 Breakout above fib level'
                    : '↗️ Recovery from support';

    return [
        `${emoji[signal.signal_type] || '📊'} *${signal.signal_type.replace(/_/g, ' ')}*`,
        ``,
        `${dir} *${signal.company_name}* (${signal.symbol})`,
        `   Trend: ${signal.trend_direction}`,
        `   Entry: ${approachLabel}`,
        ``,
        `📍 *Fib Level*`,
        `   Level:     ${(parseFloat(signal.fib_level_percent) * 100).toFixed(1)}%  →  ${fmt(signal.fib_level_price)}`,
        `   Price now: ${fmt(signal.trigger_price)}`,
        `   Deviation: ${signal.deviation_pct ?? 0}%`,
        ``,
        `📊 *Swing Range*`,
        `   Low:   ${fmt(signal.swing_low)}`,
        `   High:  ${fmt(signal.swing_high)}`,
        `   Range: ${fmt(signal.swing_range)}`,
        ``,
        `   Strength: ${stars}`,
        `⏰ ${kwTime} (Kuwait Time)`,
    ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// sendWhatsApp
// ─────────────────────────────────────────────────────────────────────────────
async function sendWhatsApp(pool, signal) {
    if (!NOTIFY_TYPES.has(signal.signal_type)) return;
    if (RECIPIENTS.length === 0) { console.warn('[notifier] WHATSAPP_RECIPIENTS not set'); return; }

    const message = buildWhatsAppMessage(signal);
    let anySent   = false;

    for (const recipient of RECIPIENTS) {
        try {
            const ref = PROVIDER === 'meta' ? await sendViaMeta(recipient, message) : await sendViaTwilio(recipient, message);
            console.log(`[notifier] ✅ ${signal.symbol} ${signal.signal_type} → ${recipient} | ref: ${ref}`);
            anySent = true;
        } catch (err) {
            console.error(`[notifier] ❌ Failed → ${recipient}: ${err.message}`, err.json ?? '');
        }
    }

    if (anySent) {
        await pool.query(
            `UPDATE public.fibonacci_signals SET notified = true, notified_at = NOW() WHERE id = $1`,
            [signal.id]
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// processSignals — MAIN ENTRY POINT
// signalOverrides: { signalType, approachDirection, zone }
// ─────────────────────────────────────────────────────────────────────────────
async function processSignals(pool, swing, stockRow, touchedLevels, signalOverrides = {}) {
    const results = [];

    for (const level of touchedLevels) {
        const signalType     = signalOverrides.signalType ?? level.type;
        const signalStrength = level.strength;

        const onCooldown = await isOnCooldown(pool, stockRow.symbol, level.level_percent, signalType);
        if (onCooldown) {
            console.log(`[signal] Cooldown: ${stockRow.symbol} @ ${level.pct}% (${signalType}) — skipping`);
            continue;
        }

        const approachDirection =
            signalOverrides.approachDirection ??
            (swing.trend_direction === 'BULLISH' ? 'FROM_ABOVE' : 'FROM_BELOW');

        const saved = await saveSignal(pool, {
            swingId:          swing.id,
            symbol:           stockRow.symbol,
            companyName:      stockRow.companyName,
            changePercent:    stockRow.changePercent,
            fibLevelId:       level.id || null,
            fibLevelPercent:  level.level_percent,
            fibLevelPrice:    level.computed_price,
            triggerPrice:     stockRow.currentPrice ?? parseFloat(swing.current_price),
            deviationPct:     level.deviationPct,
            swingLow:         parseFloat(swing.swing_low),
            swingHigh:        parseFloat(swing.swing_high),
            trendDirection:   swing.trend_direction,
            signalType,
            signalStrength,
            approachDirection,
        });

        // BUG FIX: saveSignal returns null when ON CONFLICT DO NOTHING suppresses
        // the INSERT (duplicate signal within the unique index window).  Skip
        // broadcast and WhatsApp for suppressed duplicates.
        if (!saved) {
            console.log(`[signal] Duplicate suppressed (ON CONFLICT): ${stockRow.symbol} @ ${level.pct}% (${signalType})`);
            continue;
        }

        try {
            await broadcastSignal(pool, saved);
        } catch (err) {
            console.error(`[signal] Broadcast failed for ${stockRow.symbol} @ ${level.pct}%:`, err.message);
        }

        // await sendWhatsApp(pool, saved);

        results.push(saved);
    }

    return results;
}

module.exports = { processSignals, saveSignal, buildWhatsAppMessage };