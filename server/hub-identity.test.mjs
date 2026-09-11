// hub-identity 单元测试: 身份解析与 Cookie
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewer, parseCookies, viewerCookieHeader } from './hub-identity.js';

function url(search) { return new URL(search || '/', 'http://hub'); }
function req(cookie) { return { headers: cookie ? { cookie } : {} }; }

test('resolveViewer: 无任何身份 -> NO_IDENTITY', () => {
  const v = resolveViewer(req(), url('/'));
  assert.equal(v.user, null);
  assert.equal(v.reason, 'NO_IDENTITY');
});

test('resolveViewer: URL ?user= 认定身份并要求下发 Cookie', () => {
  const v = resolveViewer(req(), url('/?user=alice'));
  assert.equal(v.user, 'alice');
  assert.equal(v.setCookie, true);
  assert.equal(v.admin, false);
});

test('resolveViewer: 非法 userId 拒绝', () => {
  assert.equal(resolveViewer(req(), url('/?user=evil/../x')).user, null);
  assert.equal(resolveViewer(req(), url('/?user=' + 'x'.repeat(65))).user, null);
});

test('resolveViewer: HUB_TOKEN 配置时必须携带 token', () => {
  const opts = { token: 'secret' };
  assert.equal(resolveViewer(req(), url('/?user=a'), opts).reason, 'TOKEN_REQUIRED');
  assert.equal(resolveViewer(req(), url('/?user=a&token=wrong'), opts).reason, 'TOKEN_REQUIRED');
  assert.equal(resolveViewer(req(), url('/?user=a&token=secret'), opts).user, 'a');
});

test('resolveViewer: Cookie 兜底认定', () => {
  const v = resolveViewer(req('dash_user=bob; other=x'), url('/'));
  assert.equal(v.user, 'bob');
  assert.equal(v.setCookie, false);
});

test('resolveViewer: admin token 进入全部视图', () => {
  const bad = resolveViewer(req(), url('/?admin=wrongtoken'), { adminToken: 'adminsecret' });
  assert.equal(bad.user, null);   // 错误 admin token 不放行
  const ok = resolveViewer(req(), url('/?admin=adminsecret'), { adminToken: 'adminsecret' });
  assert.equal(ok.user, '__all__');
  assert.equal(ok.admin, true);
});

test('resolveViewer: admin 参数错误但已有 Cookie -> 按 Cookie 用户', () => {
  const v = resolveViewer(req('dash_user=bob'), url('/?admin=wrongtoken'), { adminToken: 'adminsecret' });
  assert.equal(v.user, 'bob');
  assert.equal(v.admin, false);
});

test('parseCookies: 多个 Cookie', () => {
  const c = parseCookies({ headers: { cookie: 'a=1; dash_user=x.y@z; b=2' } });
  assert.equal(c.dash_user, 'x.y@z');
  assert.deepEqual(parseCookies({ headers: {} }), {});
});

test('viewerCookieHeader: HttpOnly + 一年有效期', () => {
  const h = viewerCookieHeader('alice');
  assert.match(h, /^dash_user=alice; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Lax$/);
  assert.equal(viewerCookieHeader('a/b'), null);
});
