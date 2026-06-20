// apps/ingestion-service/src/fib/signalGenerator.js
// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
//
// Called after every confirmed bounce.  Responsibilities:
//   1. Deduplicate — don't fire the same signal twice within COOLDOWN_MINUTES
//   2. Save the signal to fibonacci_signals
//   3. Publish to socketQueue for WebSocket broadcast
//   4. Send WhatsApp notification for configured signal types
//
// FIXES APPLIED
//   Fix 1 — notified flag no longer written when WhatsApp is disabled.
//            Previously sendWhatsApp always wrote notified=true even
//            though the send block was commented out, creating a false
//            audit trail.  Now notified/notified_at are only written
//            after a successful send.
//
//   Fix 2 — Broadcast atomicity: saveSignal sets is_broadcast=false.
//            After broadcastSignal succeeds, is_broadcast is flipped to
//            true.  A separate reconciliation job can query
//            is_broadcast=false to retry any signals that were saved but
//            never sent to the frontend.
//
//   Fix 3 — Cooldown is now symbol + level_percent + time only (no
//            swing_id).  Previously a new swing reset the cooldown for
//            every level, allowing a signal to re-fire 30 seconds after
//            the last one just because a reversal started a new swing.
//
//   Fix 4 — httpsPost now logs the full raw body before throwing on
//            non-JSON responses (e.g. Twilio/Meta HTML error pages),
//            making auth failures and rate-limit errors debuggable.

'use strict';

const { socketQueue } = require('@trading/shared');
const https           = require('https');

// ── Configuration ─────────────────────────────────────────────────────────────
const COOLDOWN_MINUTES = parseInt(process.env.SIGNAL_COOLDOWN_MINUTES || '5', 10);

const NOTIFY_TYPES = new Set(
    (process.env.NOTIFY_SIGNAL_TYPES || 'STRONG_BUY')
        .split(',').map(s => s.trim())
);

const PROVIDER   = (process.env.WHATSAPP_PROVIDER   || 'twilio').toLowerCase();
const RECIPIENTS = (process.env.WHATSAPP_RECIPIENTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// isOnCooldown  — Fix 3
// Checks symbol + fib_level_percent + time only (swing_id removed).
// A new swing no longer resets the cooldown for the same level.
// ─────────────────────────────────────────────────────────────────────────────
async function isOnCooldown(pool, symbol, fibLevelPercent) {
    const { rows } = await pool.query(
        `SELECT 1
         FROM   public.fibonacci_signals
         WHERE  symbol            = $1
           AND  fib_level_percent = $2
           AND  created_at       >= NOW() - ($3 || ' minutes')::INTERVAL
         LIMIT  1`,
        [symbol, fibLevelPercent, COOLDOWN_MINUTES]
    );
    return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// saveSignal
// Inserts one row into fibonacci_signals.
// Fix 2: is_broadcast defaults to false; flipped to true after successful
//        broadcastSignal() call.
// ─────────────────────────────────────────────────────────────────────────────
async function saveSignal(pool, {
    swingId,
    symbol,
    companyName,
    changePercent,
    fibLevelId,
    fibLevelPercent,
    fibLevelPrice,
    triggerPrice,
    deviationPct,
    swingLow,
    swingHigh,
    trendDirection,
    signalType,
    signalStrength,
    approachDirection,
}) {
    const swingRange = parseFloat(swingHigh) - parseFloat(swingLow);

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
         RETURNING *`,
        [
            swingId,      symbol,          companyName,   changePercent,
            fibLevelId,   fibLevelPercent, fibLevelPrice,
            triggerPrice, deviationPct,
            swingLow,     swingHigh,       swingRange,    trendDirection,
            signalType,   signalStrength,  approachDirection,
        ]
    );
    return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// broadcastSignal  — Fix 2
// Pushes to socket queue, then marks is_broadcast=true on success.
// If the queue call throws, is_broadcast stays false so a reconciliation
// job can retry without re-saving.
// ─────────────────────────────────────────────────────────────────────────────
async function broadcastSignal(pool, signal) {
    await socketQueue.add('fib-signal', signal, {
        removeOnComplete: true,
        removeOnFail:     { count: 20 },
    });

    // Mark as successfully broadcast only after the queue call succeeds
    await pool.query(
        `UPDATE public.fibonacci_signals
         SET    is_broadcast = true
         WHERE  id = $1`,
        [signal.id]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// httpsPost  — Fix 4: log full raw body before throwing on non-JSON
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
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(json);
                        } else {
                            // Fix 4: include parsed body in error so auth failures are readable
                            const err = new Error(`HTTP ${res.statusCode}`);
                            err.json = json;
                            reject(err);
                        }
                    } catch {
                        // Fix 4: log the raw body so HTML error pages are visible in logs
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

// ─────────────────────────────────────────────────────────────────────────────
// sendViaTwilio / sendViaMeta
// ─────────────────────────────────────────────────────────────────────────────
async function sendViaTwilio(to, message) {
    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from  = process.env.TWILIO_WHATSAPP_FROM;
    if (!sid || !token || !from) throw new Error('Twilio credentials not set');

    const dest = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const body = new URLSearchParams({ From: from, To: dest, Body: message }).toString();

    const json = await httpsPost(
        'api.twilio.com',
        `/2010-04-01/Accounts/${sid}/Messages.json`,
        {
            'Authorization': `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
            'Content-Type':  'application/x-www-form-urlencoded',
        },
        body
    );
    return json.sid;
}

async function sendViaMeta(to, message) {
    const token   = process.env.META_WHATSAPP_TOKEN;
    const phoneId = process.env.META_PHONE_NUMBER_ID;
    if (!token || !phoneId) throw new Error('Meta credentials not set');

    const phone = to.replace(/[^0-9]/g, '');
    const json  = await httpsPost(
        'graph.facebook.com',
        `/v18.0/${phoneId}/messages`,
        { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } }
    );
    return json.messages?.[0]?.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildWhatsAppMessage
// ─────────────────────────────────────────────────────────────────────────────
function buildWhatsAppMessage(signal) {
    const emoji  = { STRONG_BUY: '🟢', BUY: '🟡', RESISTANCE: '🔴', WEAK: '⚠️', TOUCH: '📍' };
    const stars  = '★'.repeat(signal.signal_strength || 1);
    const dir    = signal.trend_direction === 'BULLISH' ? '📈' : '📉';
    const kwTime = new Date().toLocaleString('en-KW', {
        timeZone: 'Asia/Kuwait', dateStyle: 'medium', timeStyle: 'short',
    });
    const fmt = n => (n != null ? Number(n).toFixed(3) : 'N/A');

    return [
        `${emoji[signal.signal_type] || '📊'} *${signal.signal_type.replace(/_/g, ' ')}*`,
        ``,
        `${dir} *${signal.company_name}* (${signal.symbol})`,
        `   Trend: ${signal.trend_direction}`,
        ``,
        `📍 *Fib Level Touched*`,
        `   Level:     ${(parseFloat(signal.fib_level_percent) * 100).toFixed(1)}%  →  ${fmt(signal.fib_level_price)}`,
        `   Price:     ${fmt(signal.trigger_price)}`,
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
// sendWhatsApp  — Fix 1
// Only writes notified/notified_at after a confirmed successful send.
// If RECIPIENTS is empty or the type is not in NOTIFY_TYPES, returns early
// without touching the DB.
// ─────────────────────────────────────────────────────────────────────────────
async function sendWhatsApp(pool, signal) {
    if (!NOTIFY_TYPES.has(signal.signal_type)) return;
    if (RECIPIENTS.length === 0) {
        console.warn('[notifier] WHATSAPP_RECIPIENTS not set — skipping notification');
        return;
    }

    const message = buildWhatsAppMessage(signal);
    let anySent   = false;

    for (const recipient of RECIPIENTS) {
        try {
            const ref = PROVIDER === 'meta'
                ? await sendViaMeta(recipient, message)
                : await sendViaTwilio(recipient, message);

            console.log(`[notifier] ✅ ${signal.symbol} ${signal.signal_type} → ${recipient} | ref: ${ref}`);
            anySent = true;
        } catch (err) {
            // Fix 4: err.json contains the parsed provider error body
            console.error(
                `[notifier] ❌ Failed → ${recipient}: ${err.message}`,
                err.json ?? ''
            );
        }
    }

    // Fix 1: only mark notified if at least one recipient received the message
    if (anySent) {
        await pool.query(
            `UPDATE public.fibonacci_signals
             SET    notified    = true,
                    notified_at = NOW()
             WHERE  id = $1`,
            [signal.id]
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// processSignals — MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
async function processSignals(pool, swing, stockRow, touchedLevels) {
    const results = [];

    for (const level of touchedLevels) {
        // Fix 3: cooldown no longer includes swing_id
        const onCooldown = await isOnCooldown(pool, stockRow.symbol, level.level_percent);
        if (onCooldown) {
            console.log(`[signal] Cooldown: ${stockRow.symbol} @ ${level.pct}% — skipping`);
            continue;
        }

        // Signal type and strength come from the DB join (fst.display_name / fst.strength).
        // classifySignalType was removed — it mapped against standard fib thresholds
        // which are irrelevant for user-defined custom ratios.
        const signalType      = level.type;
        const signalStrength  = level.strength;

        const approachDirection =
            swing.trend_direction === 'BULLISH' ? 'FROM_ABOVE' : 'FROM_BELOW';

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

        // Fix 2: broadcastSignal now also marks is_broadcast=true on success
        try {
            await broadcastSignal(pool, saved);
        } catch (err) {
            console.error(`[signal] Broadcast failed for ${stockRow.symbol} @ ${level.pct}%:`, err.message);
            // Signal is saved with is_broadcast=false — reconciliation job will retry
        }

        await sendWhatsApp(pool, saved);

        results.push(saved);
    }

    return results;
}

module.exports = { processSignals, saveSignal, buildWhatsAppMessage };