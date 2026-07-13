/**
 * 认证 API 路由 — /api/auth/*、/api/me
 * 与 GO 后端 server/handles/auth.go 对齐
 *
 * 端点：
 *   POST /api/auth/login          — 明文密码登录（内部 SHA256 哈希）
 *   POST /api/auth/login/hash     — 已哈希密码登录
 *   GET  /api/auth/logout         — 登出
 *   POST /api/auth/2fa/generate   — 生成 TOTP 二维码
 *   POST /api/auth/2fa/verify     — 验证并绑定 2FA
 *   GET  /api/me                  — 获取当前用户信息
 *   POST /api/me/update           — 更新当前用户信息
 */
import type { Hono, Context } from 'hono';
import { UsersManage } from '../users/UsersManage';
import { successResp, errorResp } from '../types/HttpResponse';

export function authRoutes(app: Hono<any>) {

    // ------------------------------------------------------------------
    // POST /api/auth/login — 明文密码登录
    // Body: { username: string, password: string, otp_code?: string }
    // ------------------------------------------------------------------
    app.post('/api/auth/login', async (c: Context): Promise<any> => {
        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        const { username, password } = body;
        if (!username || !password) return errorResp(c, '用户名和密码不能为空', 400);

        const users = new UsersManage(c);
        const result = await users.log_in({ users_name: username, users_pass: password });

        if (!result.flag) {
            const status = result.code === 429 ? 429 : 401;
            return errorResp(c, result.text || '用户名或密码错误', status);
        }
        return successResp(c, { token: result.token });
    });

    // ------------------------------------------------------------------
    // POST /api/auth/register — 用户注册（公开接口）
    // Body: { username: string, password: string, email?: string }
    // 安全修复 SEC-11: 注册前检查系统 allow_registration 开关
    // ------------------------------------------------------------------
    app.post('/api/auth/register', async (c: Context): Promise<any> => {
        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        // 检查系统注册开关
        try {
            const { AdminManage } = await import('../admin/AdminManage');
            const adminManage = new AdminManage(c);
            const setting = await adminManage.select('allow_registration');
            const allowed = setting.data?.[0]?.admin_data;
            // 默认允许注册；明确设置为 'false' 时禁止
            if (allowed === 'false' || allowed === '0') {
                return errorResp(c, '系统已关闭注册功能，请联系管理员', 403);
            }
        } catch { /* 读取设置失败时允许注册（降级处理） */ }

        const { username, password, email } = body;
        if (!username || !password) return errorResp(c, '用户名和密码不能为空', 400);

        const users = new UsersManage(c);
        const result = await users.create({
            users_name: username,
            users_pass: password,
            users_mail: email || '',
        });

        if (!result.flag) return errorResp(c, result.text || '注册失败', 400);
        return successResp(c);
    });

    // ------------------------------------------------------------------
    // POST /api/auth/login/hash — 已哈希密码登录
    // Body: { username: string, password: string, otp_code?: string }
    // ------------------------------------------------------------------
    app.post('/api/auth/login/hash', async (c: Context): Promise<any> => {
        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        const { username, password } = body;
        if (!username || !password) return errorResp(c, '用户名和密码不能为空', 400);

        const users = new UsersManage(c);
        const result = await users.log_in_hash(username, password);

        if (!result.flag) {
            const status = result.code === 429 ? 429 : 401;
            return errorResp(c, result.text || '用户名或密码错误', status);
        }
        return successResp(c, { token: result.token });
    });

    // ------------------------------------------------------------------
    // GET /api/auth/logout — 登出
    // ------------------------------------------------------------------
    app.get('/api/auth/logout', async (c: Context): Promise<any> => {
        const authHeader = c.req.header('Authorization');
        const token = authHeader?.replace('Bearer ', '').trim();
        const users = new UsersManage(c);
        await users.logout(token);
        return successResp(c);
    });

    // ------------------------------------------------------------------
    // POST /api/auth/2fa/generate — 生成 TOTP 二维码
    // 需要登录
    // ------------------------------------------------------------------
    app.post('/api/auth/2fa/generate', async (c: Context): Promise<any> => {
        const user = c.get('user');
        if (!user) return errorResp(c, '未登录', 401);

        // 生成 TOTP 密钥（32 字节 base32）
        const secretBytes = new Uint8Array(20);
        crypto.getRandomValues(secretBytes);
        const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let secret = '';
        for (let i = 0; i < secretBytes.length; i++) {
            secret += base32Chars[secretBytes[i] % 32];
        }

        // 生成 otpauth URI
        const issuer = 'OpenList';
        const account = encodeURIComponent(user.users_name);
        const otpauthUri = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

        // 生成二维码 URL（使用 Google Charts API）
        const qrUrl = `https://chart.googleapis.com/chart?chs=200x200&chld=M|0&cht=qr&chl=${encodeURIComponent(otpauthUri)}`;

        return successResp(c, { qr: qrUrl, secret });
    });

    // ------------------------------------------------------------------
    // POST /api/auth/2fa/verify — 验证并绑定 2FA
    // Body: { code: string, secret: string }
    // ------------------------------------------------------------------
    app.post('/api/auth/2fa/verify', async (c: Context): Promise<any> => {
        const user = c.get('user');
        if (!user) return errorResp(c, '未登录', 401);

        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        const { code, secret } = body;
        if (!code || !secret) return errorResp(c, 'code 和 secret 不能为空', 400);

        // 验证 TOTP 代码
        const isValid = await verifyTOTP(code, secret);
        if (!isValid) return errorResp(c, '验证码错误', 400);

        // 将 secret 保存到用户记录
        const users = new UsersManage(c);
        const updateResult = await users.config({
            users_name: user.users_name,
            otp_secret: secret,
        } as any);

        if (!updateResult.flag) return errorResp(c, updateResult.text || '保存失败', 500);
        return successResp(c);
    });

    // ------------------------------------------------------------------
    // GET /api/me — 获取当前用户信息
    // ------------------------------------------------------------------
    app.get('/api/me', async (c: Context): Promise<any> => {
        const user = c.get('user');
        if (!user) return errorResp(c, '未登录', 401);

        // 不返回密码字段
        const { users_pass, ...safeUser } = user as any;
        return successResp(c, safeUser);
    });

    // ------------------------------------------------------------------
    // POST /api/me/update — 更新当前用户信息
    // Body: { email?: string, password?: string }
    // 注意：不允许修改用户名（防止权限提升攻击，SEC-02）
    // ------------------------------------------------------------------
    app.post('/api/me/update', async (c: Context): Promise<any> => {
        const user = c.get('user');
        if (!user) return errorResp(c, '未登录', 401);

        let body: any = {};
        try { body = await c.req.json(); } catch { return errorResp(c, '请求体格式错误', 400); }

        // 安全限制：不允许修改用户名
        if (body.username && body.username !== user.users_name) {
            return errorResp(c, '用户名不可修改', 403);
        }

        const updateData: any = { users_name: user.users_name };
        // 仅允许修改邮箱和密码
        if (body.email !== undefined) updateData.users_mail = body.email;
        if (body.password) updateData.users_pass = body.password;

        const users = new UsersManage(c);
        const result = await users.config(updateData);
        if (!result.flag) return errorResp(c, result.text || '更新失败', 500);
        return successResp(c);
    });
}

// ============================================================
// TOTP 验证（RFC 6238）
// ============================================================
async function verifyTOTP(code: string, secret: string): Promise<boolean> {
    try {
        const now = Math.floor(Date.now() / 1000);
        // 检查当前时间窗口及前后各一个窗口（容忍时钟偏差）
        for (const offset of [-1, 0, 1]) {
            const counter = Math.floor(now / 30) + offset;
            const expected = await generateTOTP(secret, counter);
            if (expected === code) return true;
        }
        return false;
    } catch {
        return false;
    }
}

async function generateTOTP(secret: string, counter: number): Promise<string> {
    // Base32 解码
    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleanSecret = secret.toUpperCase().replace(/=+$/, '');
    let bits = 0, value = 0;
    const bytes: number[] = [];
    for (const char of cleanSecret) {
        const idx = base32Chars.indexOf(char);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }

    // counter → 8字节大端序
    const counterBytes = new Uint8Array(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) {
        counterBytes[i] = c & 0xff;
        c = Math.floor(c / 256);
    }

    // HMAC-SHA1
    const key = await crypto.subtle.importKey(
        'raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, counterBytes);
    const hash = new Uint8Array(sig);

    // 动态截断
    const offset = hash[hash.length - 1] & 0x0f;
    const code = ((hash[offset] & 0x7f) << 24)
        | ((hash[offset + 1] & 0xff) << 16)
        | ((hash[offset + 2] & 0xff) << 8)
        | (hash[offset + 3] & 0xff);
    return String(code % 1_000_000).padStart(6, '0');
}
