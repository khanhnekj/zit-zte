'use strict';

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── constants ──────────────────────────────────────────────────────────────
const BHN_BASE        = 'https://legacy.bot-hosting.net';
const UA              = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HCAPTCHA_SITEKEY = '21335a07-5b97-4a79-b1e9-b197dc35017a';
const HCAPTCHA_PAGEURL = 'https://legacy.bot-hosting.net/panel/earn';
const CAPTCHA_TIMEOUT  = 120_000;
const CAPTCHA_INTERVAL = 4_000;

// 3-round rewards: lần 1 +4xu, lần 2 +5xu, lần 3 +1xu
const ROUND_REWARDS = [4, 5, 1];

const PROVIDERS = {
    yescaptcha: {
        create: 'https://api.yescaptcha.com/createTask',
        result: 'https://api.yescaptcha.com/getTaskResult',
        type:   'HCaptchaTaskProxyless',
    },
    '2captcha': {
        create: 'https://api.2captcha.com/createTask',
        result: 'https://api.2captcha.com/getTaskResult',
        type:   'HCaptchaTaskProxyless',
    }
};

// ─── helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function maskToken(t) {
    if (!t || t.length < 12) return '***';
    return t.slice(0, 4) + '***' + t.slice(-4);
}

async function bhGet(path, token) {
    const r = await axios.get(`${BHN_BASE}${path}`, {
        headers: { authorization: token, 'user-agent': UA, accept: 'application/json' },
        timeout: 15_000,
        validateStatus: () => true
    });
    return { status: r.status, data: r.data };
}

async function bhPost(path, token, body) {
    const r = await axios.post(`${BHN_BASE}${path}`, body, {
        headers: { authorization: token, 'content-type': 'application/json', 'user-agent': UA },
        timeout: 20_000,
        validateStatus: () => true
    });
    return { status: r.status, data: r.data };
}

function isAuthError(data) {
    return data && typeof data === 'object' && data.error === true
        && /authoriz|invalid|expired/i.test(data.message || '');
}

async function solveHcaptcha(provider, apiKey) {
    const cfg = PROVIDERS[provider];
    if (!cfg) throw new Error(`Provider không hỗ trợ: ${provider}`);

    const create = await axios.post(cfg.create, {
        clientKey: apiKey,
        task: { type: cfg.type, websiteURL: HCAPTCHA_PAGEURL, websiteKey: HCAPTCHA_SITEKEY }
    }, { timeout: 20_000, validateStatus: () => true });

    const cd = create.data || {};
    if (cd.errorId !== 0 || !cd.taskId) {
        const err = new Error(`Captcha createTask lỗi: ${cd.errorCode || JSON.stringify(cd).slice(0,100)}`);
        err.captchaErrorCode = cd.errorCode || null;
        throw err;
    }

    const t0 = Date.now();
    while (Date.now() - t0 < CAPTCHA_TIMEOUT) {
        await sleep(CAPTCHA_INTERVAL);
        const r = await axios.post(cfg.result, { clientKey: apiKey, taskId: cd.taskId }, { timeout: 20_000, validateStatus: () => true });
        const rd = r.data || {};
        if (rd.errorId && rd.errorId !== 0) throw new Error(`Captcha getTaskResult lỗi: ${rd.errorCode}`);
        if (rd.status === 'ready') {
            const tok = rd.solution?.gRecaptchaResponse;
            if (!tok) throw new Error('Captcha solved nhưng không có gRecaptchaResponse');
            return { token: tok, tookMs: Date.now() - t0 };
        }
    }
    throw new Error('Captcha timeout (2 phút)');
}

// ─── route: GET /api/info ─────────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
    const token = (req.query.token || '').trim();
    if (!token) return res.status(400).json({ status: false, message: "Thiếu token" });

    const [user, servers, transactions, affiliate, freeStatus] = await Promise.all([
        bhGet('/api/me', token),
        bhGet('/api/servers', token),
        bhGet('/api/transactions', token),
        bhGet('/api/affiliate', token),
        bhGet('/api/freeCoinsStatus', token)
    ]);

    if (!user.data || user.status === 401 || isAuthError(user.data)) {
        return res.status(401).json({ status: false, message: 'Token sai hoặc hết hạn', token: maskToken(token) });
    }

    const u = user.data || {};
    const txList = Array.isArray(transactions.data) ? transactions.data : [];
    const fd = freeStatus.data || {};

    let cooldownMs = null;
    if (typeof fd.cooldownMs === 'number')     cooldownMs = fd.cooldownMs;
    else if (typeof fd.cooldown === 'number')  cooldownMs = fd.cooldown * 1000;
    else if (typeof fd.timeLeft === 'number')  cooldownMs = fd.timeLeft * 1000;
    if (fd.nextClaim) {
        const t = new Date(fd.nextClaim).getTime();
        if (!isNaN(t) && cooldownMs == null) cooldownMs = Math.max(0, t - Date.now());
    }

    return res.json({
        status: true,
        account: {
            id: u.id, username: u.username,
            discord: u.discordId || u.discord_id || null,
            coins: u.coins, avatar: u.avatar || null,
            created: u.createdAt || u.created || null
        },
        servers: {
            count: Array.isArray(servers.data) ? servers.data.length : null,
            list: Array.isArray(servers.data) ? servers.data.map(s => ({
                id: s.id, name: s.name, type: s.type, status: s.status, plan: s.plan
            })) : null
        },
        recentTransactions: txList.slice(0, 5).map(t => ({
            text: t.text || t.description || t.type || 'tx',
            amount: Number(t.amount ?? t.value ?? 0),
            date: t.date || t.createdAt || t.time || null
        })),
        affiliate: affiliate.status === 200 ? {
            link: affiliate.data?.link,
            count: affiliate.data?.referrals || affiliate.data?.count
        } : null,
        freeCoins: {
            claimable: !!fd.claimable,
            captchaNeeded: fd.captcha !== false,
            cooldownMs, cooldownSec: cooldownMs != null ? Math.round(cooldownMs / 1000) : null,
            nextClaimAt: fd.nextClaim || null
        },
        token: maskToken(token)
    });
});

// ─── helper: parse cooldown from freeCoinsStatus data ────────────────────
function parseCooldown(stData) {
    let cooldownMs = null;
    if (typeof stData.cooldownMs === 'number')    cooldownMs = stData.cooldownMs;
    else if (typeof stData.cooldown === 'number') cooldownMs = stData.cooldown * 1000;
    else if (typeof stData.timeLeft === 'number') cooldownMs = stData.timeLeft * 1000;
    else if (stData.nextClaim) {
        const t = new Date(stData.nextClaim).getTime();
        if (!isNaN(t)) cooldownMs = Math.max(0, t - Date.now());
    }
    return cooldownMs;
}

// ─── route: POST /api/claim ───────────────────────────────────────────────
// Nhận 1 captcha token, tự loop gọi API cho đến khi đủ xu của round đó.
// body: { token, round (1|2|3), hcaptchaToken?, captchaKey?, provider? }
app.post('/api/claim', async (req, res) => {
    const { token = '', round = 1, hcaptchaToken = '', captchaKey = '', provider = 'yescaptcha' } = req.body;
    const t0 = Date.now();
    const tk = token.trim();

    if (!tk) return res.status(400).json({ status: false, message: 'Thiếu token' });

    const roundIdx     = Math.max(0, Math.min(2, Number(round) - 1));
    const targetReward = ROUND_REWARDS[roundIdx]; // 4, 5, hoặc 1

    const logs = []; // ghi lại từng lần +1xu để frontend hiển thị

    try {
        // ── 1. Kiểm tra trạng thái ban đầu ──────────────────────────────
        const st = await bhGet('/api/freeCoinsStatus', tk);
        if (st.status === 401 || isAuthError(st.data)) {
            return res.status(401).json({ status: false, message: 'Token sai hoặc hết hạn' });
        }

        const stData = st.data || {};
        if (!stData.claimable) {
            const cooldownMs = parseCooldown(stData);
            return res.json({
                status: false, claimed: false,
                message: 'Đang trong cooldown, chưa thể claim',
                cooldownMs,
                cooldownSec: cooldownMs != null ? Math.round(cooldownMs / 1000) : null,
                nextClaim: stData.nextClaim || null
            });
        }

        // ── 2. Lấy captcha token (1 lần duy nhất) ───────────────────────
        const captchaNeeded = stData.captcha !== false;
        let captchaTokenVal = null, captchaSource = null, captchaTookMs = 0;

        if (captchaNeeded) {
            if (hcaptchaToken.trim()) {
                captchaTokenVal = hcaptchaToken.trim();
                captchaSource   = 'manual';
            } else if (captchaKey.trim()) {
                const prov = ['yescaptcha', '2captcha'].includes(provider) ? provider : 'yescaptcha';
                const sol  = await solveHcaptcha(prov, captchaKey.trim());
                captchaTokenVal = sol.token;
                captchaTookMs   = sol.tookMs;
                captchaSource   = prov;
            } else {
                return res.status(400).json({
                    status: false,
                    message: 'Cần captcha — gửi hcaptchaToken (tự giải) hoặc captchaKey',
                    siteKey: HCAPTCHA_SITEKEY,
                    pageUrl: HCAPTCHA_PAGEURL,
                    needCaptcha: true
                });
            }
        }

        // ── 3. Loop claim cho đến khi đủ xu của round ───────────────────
        let totalGained = 0;
        let lastBalance = null;
        let lastUsername = null;

        while (totalGained < targetReward) {
            // Delay nhỏ giữa các lần để tránh rate-limit
            if (totalGained > 0) await sleep(600);

            const cr = await bhPost('/api/freeCoins', tk, { hCaptchaResponse: captchaTokenVal || null });

            if (cr.status === 401) {
                return res.status(401).json({
                    status: false,
                    message: 'Token hết hạn trong khi đang claim',
                    gained: totalGained, targetReward, logs
                });
            }

            const result = cr.data || {};
            const ok = !!result.success;

            if (!ok) {
                // Có thể cooldown xuất hiện giữa chừng hoặc lỗi khác
                const stCheck = await bhGet('/api/freeCoinsStatus', tk);
                const stC = stCheck.data || {};
                if (!stC.claimable) {
                    const cooldownMs = parseCooldown(stC);
                    return res.json({
                        status: false, claimed: totalGained > 0,
                        message: `Dừng giữa chừng: cooldown xuất hiện sau ${totalGained}/${targetReward}xu`,
                        gained: totalGained, targetReward, logs,
                        cooldownMs,
                        cooldownSec: cooldownMs != null ? Math.round(cooldownMs / 1000) : null,
                        balance: lastBalance, username: lastUsername,
                        tookMs: Date.now() - t0
                    });
                }
                // Lỗi khác — thử tiếp
                logs.push({ step: totalGained + 1, ok: false, msg: result.message || 'Claim thất bại, thử lại...' });
                continue;
            }

            // Thành công: +1xu mỗi lần
            totalGained += 1;
            const me = (await bhGet('/api/me', tk)).data || {};
            lastBalance  = me.coins ?? null;
            lastUsername = me.username || null;
            logs.push({ step: totalGained, ok: true, balance: lastBalance });
        }

        // ── 4. Trả về kết quả ────────────────────────────────────────────
        return res.json({
            status: true, claimed: true,
            message: `✅ Hoàn thành lần ${round}/3! +${totalGained}xu (${targetReward}xu mục tiêu)`,
            amount: totalGained,
            targetReward,
            balance: lastBalance,
            username: lastUsername,
            round: Number(round),
            captchaUsed: captchaNeeded,
            captchaSource, captchaTookMs,
            logs,
            tookMs: Date.now() - t0,
            token: maskToken(tk)
        });

    } catch (e) {
        return res.status(500).json({ status: false, message: String(e?.message || e), tookMs: Date.now() - t0 });
    }
});

// ─── route: GET / (frontend) ──────────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✅ BotHosting Claimer running on port ${PORT}`));
