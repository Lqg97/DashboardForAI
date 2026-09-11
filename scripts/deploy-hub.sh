#!/usr/bin/env bash
# 部署联机 Hub 到远程服务器
# 用法: bash scripts/deploy-hub.sh [--no-restart]
# 依赖: 本机可 ssh <REMOTE_USER>@<REMOTE_HOST> -p <REMOTE_PORT>
# 服务器侧: Node >= 22(自动安装)、MySQL 容器 ai-sub-mysql(自动创建)
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-your-hub-host}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/ai-sub-dashboard}"
HUB_PORT="${HUB_PORT:-4780}"
NODE_VERSION="${NODE_VERSION:-22.23.1}"

SSH="ssh -p ${REMOTE_PORT} -o BatchMode=yes ${REMOTE_USER}@${REMOTE_HOST}"
SCP="scp -P ${REMOTE_PORT} -o BatchMode=yes"

echo "==> 目标 ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PORT} -> ${REMOTE_DIR}"

echo "==> [1/6] 远程 Node.js 检查/安装 (v${NODE_VERSION})"
$SSH "
  if [ -x /usr/local/node-v${NODE_VERSION}/bin/node ]; then echo 'node 已存在'; exit 0; fi
  echo '下载 Node v${NODE_VERSION} (npmmirror)...'
  curl -fsSL -o /tmp/node.tar.xz https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz
  mkdir -p /usr/local/node-v${NODE_VERSION}
  tar -xJf /tmp/node.tar.xz -C /usr/local/node-v${NODE_VERSION} --strip-components=1
  ln -sf /usr/local/node-v${NODE_VERSION}/bin/node /usr/local/bin/node
  ln -sf /usr/local/node-v${NODE_VERSION}/bin/npm /usr/local/bin/npm
  rm -f /tmp/node.tar.xz
"
$SSH "node -v"

echo "==> [2/6] MySQL 容器检查/创建"
$SSH bash -s <<'REMOTE_MYSQL'
set -e
if docker ps --format '{{.Names}}' | grep -q '^ai-sub-mysql$'; then
  echo 'MySQL 容器已在运行'
else
  echo '创建 MySQL 容器...'
  mkdir -p /opt/ai-sub-mysql/data
  PASS=$(head -c 24 /dev/urandom | base64 | tr -d "=+/" | head -c 20)
  docker run -d --name ai-sub-mysql \
    --restart unless-stopped \
    -p 127.0.0.1:3306:3306 \
    -e MYSQL_ROOT_PASSWORD="$PASS" \
    -e MYSQL_DATABASE=ai_sub_dashboard \
    -e TZ=Asia/Shanghai \
    -v /opt/ai-sub-mysql/data:/var/lib/mysql \
    mysql:8.0 \
    --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci \
    --max_connections=200
  umask 077
  printf "MYSQL_HOST=127.0.0.1\nMYSQL_PORT=3306\nMYSQL_USER=ai_sub\nMYSQL_PASSWORD=%s\nMYSQL_DATABASE=ai_sub_dashboard\nMYSQL_ROOT_PASSWORD=%s\n" "$PASS" "$PASS" > /opt/ai-sub-mysql/.env
  echo 'MySQL 容器已创建'
fi
if [ ! -f /opt/ai-sub-mysql/.env ]; then
  echo '缺少 /opt/ai-sub-mysql/.env, 请检查容器' >&2; exit 1
fi
REMOTE_MYSQL

echo "==> [3/6] 同步代码 (server/ public/ package.json)"
$SSH "mkdir -p ${REMOTE_DIR}"
rsync -az --delete -e "ssh -p ${REMOTE_PORT} -o BatchMode=yes" \
  --exclude 'node_modules' --exclude 'data/' \
  ./server ./public ./scripts package.json "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

echo "==> [4/6] 安装运行依赖 (mysql2, npmmirror)"
$SSH "
  cd ${REMOTE_DIR}
  export MYSQL_PASSWORD_PLACEHOLDER=1
  npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund
  node -e \"require.resolve('mysql2') && console.log('mysql2 ok')\"
"

echo "==> [5/6] systemd 服务 (hub) + 环境文件"
$SSH bash -s <<REMOTE_UNIT
set -e
mkdir -p ${REMOTE_DIR}
# Hub 环境文件: 数据库凭据 + 端口 + 访问令牌 (600 权限)
umask 077
# 令牌仅首次生成, 之后复用(重部署不变)
if [ -f ${REMOTE_DIR}/hub.env ] && grep -q '^HUB_TOKEN=' ${REMOTE_DIR}/hub.env; then
  HUB_TOKEN_NOW=\$(grep '^HUB_TOKEN=' ${REMOTE_DIR}/hub.env | cut -d= -f2)
  HUB_ADMIN_TOKEN_NOW=\$(grep '^HUB_ADMIN_TOKEN=' ${REMOTE_DIR}/hub.env | cut -d= -f2)
else
  HUB_TOKEN_NOW=\$(head -c 24 /dev/urandom | base64 | tr -d "=+/" | head -c 24)
  HUB_ADMIN_TOKEN_NOW=\$(head -c 24 /dev/urandom | base64 | tr -d "=+/" | head -c 24)
fi
{
  grep -E '^(MYSQL_HOST|MYSQL_PORT|MYSQL_USER|MYSQL_PASSWORD|MYSQL_DATABASE)=' /opt/ai-sub-mysql/.env || true
  echo "HUB_PORT=${HUB_PORT}"
  echo "HUB_HOST=0.0.0.0"
  echo "DATA_DIR=${REMOTE_DIR}/data"
  echo "HUB_TOKEN=\${HUB_TOKEN_NOW}"
  echo "HUB_ADMIN_TOKEN=\${HUB_ADMIN_TOKEN_NOW}"
} > ${REMOTE_DIR}/hub.env
chmod 600 ${REMOTE_DIR}/hub.env

cat > /etc/systemd/system/ai-sub-hub.service <<EOF
[Unit]
Description=AI Sub Dashboard Hub (联机版看板服务)
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=${REMOTE_DIR}
EnvironmentFile=${REMOTE_DIR}/hub.env
ExecStart=/usr/local/bin/node ${REMOTE_DIR}/server/hub.js
Restart=always
RestartSec=5
User=root
NoNewPrivileges=true
StandardOutput=append:/var/log/ai-sub-hub.log
StandardError=append:/var/log/ai-sub-hub.log

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ai-sub-hub >/dev/null
systemctl restart ai-sub-hub
sleep 2
echo "HUB_TOKEN=\${HUB_TOKEN_NOW}" > /root/.ai-sub-hub-token
chmod 600 /root/.ai-sub-hub-token
REMOTE_UNIT

echo "==> [6/6] 验证"
sleep 2
$SSH "curl -fsS http://127.0.0.1:${HUB_PORT}/api/users | head -c 200; echo"
$SSH "
  TOKEN=\$(grep '^HUB_TOKEN=' ${REMOTE_DIR}/hub.env | cut -d= -f2)
  echo '---- 个人链接示例(需要 token 才能认定身份):'
  echo \"http://${REMOTE_HOST}:${HUB_PORT}/?user=<你的用户ID>&token=\${TOKEN}\"
  echo '---- 客户端启动命令:'
  echo \"DASH_TOKEN=\${TOKEN} HUB_URL=http://${REMOTE_HOST}:${HUB_PORT} npm run client\"
"
echo "部署完成: 看板 http://${REMOTE_HOST}:${HUB_PORT} (内网访问; 每人使用个人链接, 只能看到自己的数据)"
