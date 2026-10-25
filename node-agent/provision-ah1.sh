#!/usr/bin/env bash
# K0-Q25：ah1 容器一次性 provisioning（幂等；在 xc 宿主机执行）。
#
# 做的事：
#   1. 以 dev 用户装 opencode（版本对齐宿主机；可用 OPENCODE_VERSION 覆盖）；
#   2. 写 /home/dev/.config/opencode/opencode.json（默认模型，不含密钥）；
#   3. 只把宿主机 auth.json 的 opencode-go 条目机对机搬进容器（绝不打印值）；
#   4. 建 /home/dev/xuxing-runs，核对 xuxing clone 远端并 fetch 冒烟；
#   5. 冒烟：opencode --version + 一次最小 opencode run（回复 OK）。
#
# 不动：sshd、22224 隧道、既有目录与 BRIEFING 流程。
#
# 用法：
#   ./node-agent/provision-ah1.sh
#   OPENCODE_VERSION=2.1.2 ./node-agent/provision-ah1.sh
set -euo pipefail

CONTAINER="${XUXING_HANDS_CONTAINER:-ah1}"
HANDS_USER="${XUXING_HANDS_USER:-dev}"
HANDS_HOME="/home/${HANDS_USER}"
MODEL="${XUXING_AGENT_MODEL:-opencode-go/deepseek-v4.1-flash}"
BASE_REF="${XUXING_AGENT_BASE_REF:-develop/eventstore-batch1}"
REPO_DIR="${XUXING_AGENT_REPO_DIR:-${HANDS_HOME}/xuxing}"
RUNS_DIR="${XUXING_AGENT_RUNS_DIR:-${HANDS_HOME}/xuxing-runs}"
HOST_AUTH_FILE="${HOST_OPENCODE_AUTH_FILE:-${HOME}/.local/share/opencode/auth.json}"
HOST_OPENCODE_BIN="${HOST_OPENCODE_BIN:-$(command -v opencode || true)}"

log() { printf '[provision-ah1] %s\n' "$1"; }
fail() { printf '[provision-ah1] ERROR: %s\n' "$1" >&2; exit 1; }

as_dev() {
  docker exec -e HOME="${HANDS_HOME}" -u "${HANDS_USER}" "${CONTAINER}" bash -lc "$1"
}

docker inspect "${CONTAINER}" >/dev/null 2>&1 || fail "容器 ${CONTAINER} 不存在"

# ---- 1. opencode -----------------------------------------------------------
if [ -z "${OPENCODE_VERSION:-}" ]; then
  if [ -n "${HOST_OPENCODE_BIN}" ] && [ -x "${HOST_OPENCODE_BIN}" ]; then
    OPENCODE_VERSION="$("${HOST_OPENCODE_BIN}" --version | sed -E 's/^opencode v//')"
  else
    OPENCODE_VERSION="2.1.2"
  fi
fi
log "opencode 目标版本 ${OPENCODE_VERSION}"

INSTALLED_VERSION=""
if as_dev "test -x ${HANDS_HOME}/.opencode/bin/opencode" >/dev/null 2>&1; then
  INSTALLED_VERSION="$(as_dev "${HANDS_HOME}/.opencode/bin/opencode --version" | sed -E 's/^opencode v//')"
fi
if [ "${INSTALLED_VERSION}" = "${OPENCODE_VERSION}" ]; then
  log "opencode 已安装（${INSTALLED_VERSION}），跳过"
else
  log "以 ${HANDS_USER} 安装 opencode ${OPENCODE_VERSION}"
  as_dev "curl -fsSL https://opencode.ai/v2/install | bash -s -- --version ${OPENCODE_VERSION} --no-modify-path" >/dev/null
  INSTALLED_VERSION="$(as_dev "${HANDS_HOME}/.opencode/bin/opencode --version" | sed -E 's/^opencode v//')"
  [ "${INSTALLED_VERSION}" = "${OPENCODE_VERSION}" ] || fail "安装后版本不匹配：${INSTALLED_VERSION}"
  log "opencode 安装完成（${INSTALLED_VERSION}）"
fi

# ---- 2. opencode.json（不含任何密钥） --------------------------------------
CONFIG_JSON="$(cat <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "${MODEL}",
  "permission": {
    "edit": "allow",
    "bash": "allow",
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "list": "allow",
    "external_directory": "allow"
  }
}
EOF
)"
as_dev "install -d -m 700 ${HANDS_HOME}/.config/opencode"
printf '%s' "${CONFIG_JSON}" | docker exec -i -u "${HANDS_USER}" "${CONTAINER}" \
  bash -lc "cat > ${HANDS_HOME}/.config/opencode/opencode.json"
as_dev "chmod 644 ${HANDS_HOME}/.config/opencode/opencode.json"
log "已写 opencode.json（model=${MODEL}，无密钥）"

# ---- 3. 令牌最小化拷贝（只抽 opencode-go；不打印值） ----------------------
[ -f "${HOST_AUTH_FILE}" ] || fail "宿主机 auth.json 不存在：${HOST_AUTH_FILE}"
jq -e 'has("opencode-go")' "${HOST_AUTH_FILE}" >/dev/null || fail "宿主机 auth.json 缺 opencode-go 条目"
as_dev "install -d -m 700 ${HANDS_HOME}/.local/share/opencode"
TMP_AUTH_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_AUTH_DIR}"' EXIT
(umask 077 && jq '{"opencode-go": .["opencode-go"]}' "${HOST_AUTH_FILE}" > "${TMP_AUTH_DIR}/auth.json")
docker cp "${TMP_AUTH_DIR}/auth.json" "${CONTAINER}:${HANDS_HOME}/.local/share/opencode/auth.json"
docker exec -u root "${CONTAINER}" bash -lc \
  "chown ${HANDS_USER}:${HANDS_USER} ${HANDS_HOME}/.local/share/opencode/auth.json && chmod 600 ${HANDS_HOME}/.local/share/opencode/auth.json"
log "opencode-go 令牌已拷贝（值未输出）"

# ---- 4. runs 目录 + clone 远端核对 ----------------------------------------
docker exec -u root "${CONTAINER}" bash -lc \
  "install -d -o ${HANDS_USER} -g ${HANDS_USER} ${RUNS_DIR}"
as_dev "test -d ${REPO_DIR}/.git" >/dev/null || fail "容器内 xuxing clone 不存在：${REPO_DIR}"
REMOTE_URL="$(as_dev "git -C ${REPO_DIR} remote get-url origin")"
case "${REMOTE_URL}" in
  *medivhc/xuxing.git|*medivhc/xuxing) ;;
  *) fail "远端不是 medivhc/xuxing：${REMOTE_URL}" ;;
esac
log "xuxing clone 远端核对通过（deploy key）"
as_dev "git -C ${REPO_DIR} fetch origin ${BASE_REF}" >/dev/null 2>&1 || fail "git fetch origin ${BASE_REF} 失败"
log "git fetch origin ${BASE_REF} 通过"

# ---- 5. 冒烟 ---------------------------------------------------------------
AUTH_FILE="${HANDS_HOME}/.local/share/opencode/auth.json"
VERSION_OUT="$(as_dev "${HANDS_HOME}/.opencode/bin/opencode --version")"
log "opencode --version: ${VERSION_OUT}"
# v2 的 provider 凭据走 OPENCODE_API_KEY（从容器内 auth.json 读取，不落配置、不打印）。
SMOKE_OUT="$(
  as_dev "cd ${RUNS_DIR} && OPENCODE_API_KEY=\$(jq -r '.[\"opencode-go\"].key' ${AUTH_FILE}) ${HANDS_HOME}/.opencode/bin/opencode run --standalone --model ${MODEL} 'Reply with exactly: OK'" 2>&1 || true
)"
if printf '%s' "${SMOKE_OUT}" | grep -q 'OK'; then
  log "opencode run 冒烟通过（模型通路 OK）"
else
  # 不回显输出：避免任何凭据/诊断文本落入日志。
  fail "opencode run 冒烟未回 OK（输出已省略；请手工排查模型/凭据）"
fi

log "完成：opencode=${INSTALLED_VERSION} model=${MODEL} user=${HANDS_USER} runs=${RUNS_DIR}"
