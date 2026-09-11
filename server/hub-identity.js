// Hub 身份识别: 每个用户只能看到自己的数据
// 身份来源(优先级): URL ?user=<userId>(可选 ?token=) → Cookie dash_user
// - HUB_TOKEN 配置时: URL 首次认定必须携带相同 token(与客户端上报令牌一致), 防止冒用他人 userId
// - HUB_ADMIN_TOKEN 配置时: ?admin=<token> 可进入「全部用户汇总」视图(仅管理员)
// - URL 认定成功后下发 HttpOnly Cookie(dash_user, 1年), 后续访问无需再带参数

const COOKIE_NAME = 'dash_user';
const USER_ID_RE = /^[A-Za-z0-9_.@-]{1,64}$/;
export const ADMIN_USER = '__all__';

export function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

// 解析访问者: {user, admin:boolean, setCookie:boolean, reason?}
export function resolveViewer(req, urlObj, opts = {}) {
  const cookies = parseCookies(req);
  const qUser = urlObj.searchParams.get('user');
  const qToken = urlObj.searchParams.get('token');
  const qAdmin = urlObj.searchParams.get('admin');

  // 管理员视图
  if (qAdmin && opts.adminToken && qAdmin === opts.adminToken) {
    return { user: ADMIN_USER, admin: true, setCookie: false };
  }

  // URL 个人链接认定
  if (qUser) {
    if (!USER_ID_RE.test(qUser.trim())) return { user: null, admin: false, setCookie: false, reason: 'INVALID_USER' };
    if (opts.token && qToken !== opts.token) return { user: null, admin: false, setCookie: false, reason: 'TOKEN_REQUIRED' };
    return { user: qUser.trim(), admin: false, setCookie: true };
  }

  // Cookie 认定
  const cUser = cookies[COOKIE_NAME];
  if (cUser && USER_ID_RE.test(cUser)) return { user: cUser, admin: false, setCookie: false };

  return { user: null, admin: false, setCookie: false, reason: 'NO_IDENTITY' };
}

// 下发给浏览器的身份 Cookie
export function viewerCookieHeader(userId) {
  if (!USER_ID_RE.test(String(userId || ''))) return null;
  return `${COOKIE_NAME}=${encodeURIComponent(userId)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}
