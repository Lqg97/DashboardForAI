#!/usr/bin/env bash
# 构建桌面端产物(内网 / 外网两套 profile)
#
# 用法:
#   bash scripts/build-dist.sh internal            # 内网版: 内置内网 Hub 地址与令牌, 开箱即用
#   bash scripts/build-dist.sh public              # 外网版: 不内置任何 Hub 默认值, 首次启动由用户填写
#   bash scripts/build-dist.sh public --dir-only   # 只出 .app 目录, 不打 dmg
#
# 产物目录: dist/<profile>/
#
# 内网/外网的差异来自代码本身(见 scripts/export-public.sh), 本脚本只负责:
#   1. 打包前确认本机运行数据不会被打进产物
#   2. 按 profile 构建到独立目录
#   3. 构建后扫描产物, 确认无本机凭据 / (外网版)无内网痕迹
set -euo pipefail

PROFILE="${1:-internal}"
DIR_ONLY=0
for arg in "$@"; do
  [ "$arg" = "--dir-only" ] && DIR_ONLY=1
done

if [ "$PROFILE" != "internal" ] && [ "$PROFILE" != "public" ]; then
  echo "用法: bash scripts/build-dist.sh [internal|public] [--dir-only]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="dist/${PROFILE}"

echo "==> [0/4] 环境检查"
node -v
if [ ! -x node_modules/.bin/electron-builder ]; then
  echo "缺少 electron-builder, 请先执行 npm install" >&2
  exit 1
fi

echo "==> [1/4] 确认打包清单不含本机运行数据"
# data/ 下的 config.json(凭据) / settings.json(Hub 令牌) / snapshot.json(用量) 都不应进包。
# package.json 的 build.files 只允许 data/config.example.json。
if grep -q '"data/\*\*/\*"' package.json; then
  echo "✗ package.json 的 build.files 含 data/**/*, 会把本机凭据打进产物" >&2
  exit 1
fi
echo "    build.files 已收紧: 仅 data/config.example.json"

echo "==> [2/4] 按 profile 校验内置默认值"
if [ "$PROFILE" = "public" ]; then
  # 外网版不应内置任何 Hub 地址/令牌, 也不应残留内网域名
  if grep -nE "DEFAULT_HUB_(URL|TOKEN) *= *(process\.env\.[A-Z_]+ *\|\| *)?'[^']+'" server/config.js; then
    echo "✗ 外网版不应内置 Hub 默认值, 请先执行 scripts/export-public.sh 生成外网仓" >&2
    exit 1
  fi
  if grep -rqIE "woa\.com|tencentyun|devcloud" server public desktop 2>/dev/null; then
    echo "✗ 外网版源码中仍存在内网痕迹, 请检查 server/public/desktop" >&2
    exit 1
  fi
  echo "    外网版: 无内置 Hub 默认值, 无内网痕迹"
else
  echo "    内网版: 使用 server/config.js 中内置的 Hub 默认值"
fi

echo "==> [3/4] 构建 (profile=${PROFILE}) -> ${OUT}"

# 签名身份检查: 有 Developer ID Application 就会自动签名, 没有则退回 ad-hoc
# (ad-hoc 的产物别人首次打开会被 Gatekeeper 拦下, 需 xattr -cr)
IDENT="$(security find-identity -v -p codesigning 2>/dev/null | grep -m1 'Developer ID Application' | sed -E 's/.*"([^"]+)".*/\1/')"
if [ -n "$IDENT" ]; then
  echo "    签名身份: ${IDENT}"
else
  echo "    ⚠ 未找到 Developer ID Application 证书, 产物将是 ad-hoc 签名"
fi

# 公证: 需要 Apple 团队 ID + 鉴权信息, 缺任一就跳过(不阻断构建)
NOTARIZE_ARGS=()
if [ -n "${APPLE_TEAM_ID:-}" ]; then
  if [ -n "${APPLE_ID:-}${APPLE_API_KEY:-}" ]; then
    NOTARIZE_ARGS=(-c.mac.notarize.teamId="$APPLE_TEAM_ID")
    echo "    公证: 已配置(teamId=${APPLE_TEAM_ID})"
  else
    echo "    ⚠ 设置了 APPLE_TEAM_ID 但缺少 APPLE_ID / APPLE_API_KEY, 跳过公证"
  fi
else
  echo "    公证: 未配置(设置 APPLE_TEAM_ID + APPLE_ID 等环境变量后自动启用)"
fi

rm -rf "$OUT"
if [ "$DIR_ONLY" = "1" ]; then
  node_modules/.bin/electron-builder --mac --dir "${NOTARIZE_ARGS[@]}" -c.directories.output="$OUT"
else
  node_modules/.bin/electron-builder --mac dmg "${NOTARIZE_ARGS[@]}" -c.directories.output="$OUT"
fi

echo "==> [4/4] 产物安全扫描"
# 注意: 不能用 grep 直接在 app.asar 上搜字符串 —— UI 文案里就有 "data/config.json"
# 这类字样, 会误报。这里用 @electron/asar 真实列出包内文件清单来判定。
# 路径深度: dist/<profile>/mac-arm64/<App>.app/Contents/Resources/app.asar
ASAR="$(find "$OUT" -name app.asar -maxdepth 8 | head -1)"
if [ -z "$ASAR" ]; then
  echo "✗ 未找到 app.asar, 无法确认产物内容" >&2
  exit 1
fi
ASAR="$ASAR" PROFILE="$PROFILE" node - <<'SCAN_JS'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');
const files = listPackage(process.env.ASAR);
const profile = process.env.PROFILE;
console.log(`    包内文件数: ${files.length}`);
let leak = 0;
// 1) 本机运行数据(含凭据/令牌/用量)
for (const f of files) {
  if (/^\/data\/(config|settings|snapshot|providers)\.json$/.test(f)) {
    console.error(`✗ 产物内含本机数据文件: ${f}`);
    leak = 1;
  }
}
// 2) 外网版: 不应存在任何 WOA / 内网模块
if (profile === 'public') {
  for (const f of files) {
    if (/woa|ttu/i.test(f)) {
      console.error(`✗ 外网产物内含 WOA/TTU 模块: ${f}`);
      leak = 1;
    }
  }
}
if (leak) {
  console.error('✗ 产物安全扫描未通过, 请不要分发');
  process.exit(1);
}
console.log(`    data/ 内容: ${files.filter(f => f.startsWith('/data')).join(', ') || '(空)'}`);
console.log('    扫描通过: 无本机数据, 无(外网版) WOA/TTU 模块');
SCAN_JS

echo
echo "✓ 构建完成: ${OUT}"
find "$OUT" -maxdepth 1 -mindepth 1 | sed 's/^/    /'
