// apps/ingestion-service/src/fib/signalGenerator.js
// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
//
// Called after every tick where price touches a user-defined fib level.
// Responsibilities:
//   1. Deduplicate — don't fire the same signal twice within COOLDOWN_MINUTES
//   2. Save the signal to fibonacci_signals table
//   3. Publish to socketQueue so WebSocket broadcasts it to frontend
//   4. Send WhatsApp notification for STRONG_BUY signals
//
// COOLDOWN
//   If the same symbol touched the same fib level in the last COOLDOWN_MINUTES,
//   skip it. This prevents spamming when price sits at a level for several ticks.

'use strict';

const { socketQueue } = require('@trading/shared');

// How many minutes must pass before re-firing same symbol + same level
const COOLDOWN_MINUTES = parseInt(process.env.SIGNAL_COOLDOWN_MINUTES || '5', 10);

// Which signal types trigger WhatsApp
const NOTIFY_TYPES = new Set(
    (process.env.NOTIFY_SIGNAL_TYPES || 'STRONG_BUY')
        .split(',').map(s => s.trim())
);

// ─────────────────────────────────────────────────────────────────────────────
// isOnCooldown
// Returns true if we already fired this symbol + fib_level_percent in the last
// COOLDOWN_MINUTES minutes. Prevents duplicate alerts per tick.
// ─────────────────────────────────────────────────────────────────────────────
async function isOnCooldown(pool, symbol, swingId, fibLevelPercent) {
    const { rows } = await pool.query(
        `SELECT 1
         FROM   public.fibonacci_signals
         WHERE  symbol            = $1
           AND  swing_id          = $2
           AND  fib_level_percent = $3
           AND  created_at        >= NOW() - ($4 || ' minutes')::INTERVAL
         LIMIT  1`,
        [symbol, swingId, fibLevelPercent, COOLDOWN_MINUTES]
    );
    return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// saveSignal — inserts one row into fibonacci_signals
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
           signal_type, signal_strength, approach_direction
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
            swingId,        symbol,          companyName, changePercent,
            fibLevelId,     fibLevelPercent, fibLevelPrice,
            triggerPrice,   deviationPct,
            swingLow,       swingHigh,       swingRange,     trendDirection,
            signalType,     signalStrength,  approachDirection,
        ]
    );
    return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// broadcastSignal — push to socket-queue so WebSocket picks it up
// ─────────────────────────────────────────────────────────────────────────────
async function broadcastSignal(signal) {
    await socketQueue.add('fib-signal', signal, {
        removeOnComplete: true,
        removeOnFail: { count: 20 },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// sendWhatsApp — HTTP post to Twilio / Meta Cloud API
// Only fires for signal types in NOTIFY_TYPES.
// ─────────────────────────────────────────────────────────────────────────────
const https = require('https');

const PROVIDER     = (process.env.WHATSAPP_PROVIDER   || 'twilio').toLowerCase();
const RECIPIENTS   = (process.env.WHATSAPP_RECIPIENTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

function buildWhatsAppMessage(signal) {
    const emoji = { STRONG_BUY: '🟢', BUY: '🟡', RESISTANCE: '🔴', WEAK: '⚠️', TOUCH: '📍' };
    const stars = '★'.repeat(signal.signal_strength || 1);
    const dir   = signal.trend_direction === 'BULLISH' ? '📈' : '📉';
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
        // `   Level:     ${signal.fib_level_percent}%  →  ${fmt(signal.fib_level_price)}`,
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
                        else reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { json }));
                    } catch {
                        reject(new Error(`Non-JSON: ${data.slice(0, 200)}`));
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

async function sendWhatsApp(pool, signal) {
    if (!NOTIFY_TYPES.has(signal.signal_type)) return;
    if (RECIPIENTS.length === 0) {
        console.warn('[notifier] WHATSAPP_RECIPIENTS not set');
        return;
    }

    const message = buildWhatsAppMessage(signal);

    for (const recipient of RECIPIENTS) {
        console.log('recipient: ', recipient);
        // try {
        //     const ref = PROVIDER === 'meta'
        //         ? await sendViaMeta(recipient, message)
        //         : await sendViaTwilio(recipient, message);

        //     console.log(`[notifier] ✅ ${signal.symbol} ${signal.signal_type} → ${recipient} | ref: ${ref}`);
        // } catch (err) {
        //     console.error(`[notifier] ❌ Failed → ${recipient}: ${err.message}`);
        // }
    }

    // Mark signal as notified
    await pool.query(
        `UPDATE public.fibonacci_signals
         SET    notified    = true,
                notified_at = NOW()
         WHERE  id = $1`,
        [signal.id]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// processSignals — MAIN ENTRY POINT
//
// Given a swing and the touched fib levels, deduplicate, save, broadcast,
// and notify for each touched level.
//
// @param {Pool}     pool
// @param {object}   swing          — DB row from fibonacci_swings
// @param {object}   stockRow       — scraped stock object (has symbol, companyName, etc.)
// @param {object[]} touchedLevels  — from fibCalculator.findTouchedLevels()
// ─────────────────────────────────────────────────────────────────────────────
async function processSignals(pool, swing, stockRow, touchedLevels) {
    console.log('stockRow: ', stockRow);
    const results = [];

    for (const level of touchedLevels) {
        // Cooldown check — skip if same symbol + level fired recently
        const onCooldown = await isOnCooldown(pool, stockRow.symbol, swing.id, level.level_percent);
        if (onCooldown) {
            console.log(`[signal] Cooldown: ${stockRow.symbol} @ ${level.pct}% — skipping`);
            continue;
        }

        const { type: signalType, strength: signalStrength } =
            require('./fibCalculator').classifySignalType(level.pct, swing.trend_direction);

        // Determine approach direction from trend
        const approachDirection =
            swing.trend_direction === 'BULLISH' ? 'FROM_ABOVE' : 'FROM_BELOW';

        // Save to DB
        const saved = await saveSignal(pool, {
            swingId:          swing.id,
            symbol:           stockRow.symbol,
            companyName:      stockRow.companyName,
            changePercent:    stockRow.changePercent,
            fibLevelId:       level.id || null,
            fibLevelPercent:  level.level_percent,
            fibLevelPrice:    level.computed_price,
            triggerPrice:     parseFloat(swing.current_price),
            deviationPct:     level.deviationPct,
            swingLow:         parseFloat(swing.swing_low),
            swingHigh:        parseFloat(swing.swing_high),
            trendDirection:   swing.trend_direction,
            signalType,
            signalStrength,
            approachDirection,
        });

        // console.log(
        //     `[signal] ${signalType} | ${stockRow.symbol} | ` +
        //     `${level.pct}% → ${level.computed_price} | ` +
        //     `price: ${swing.current_price}`
        // );

        // Broadcast to frontend via socket queue
        await broadcastSignal(saved);

        // WhatsApp notification
        await sendWhatsApp(pool, saved);

        results.push(saved);
    }

    return results;
}

module.exports = { processSignals, saveSignal, buildWhatsAppMessage };