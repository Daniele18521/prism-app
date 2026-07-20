#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODENAME="$(lsb_release -cs)"

echo "Ubuntu codename: ${CODENAME}"

rm -f /etc/apt/sources.list.d/redis.list

apt-get update
apt-get install -y curl gpg lsb-release ca-certificates

GPG_SRC="${SCRIPT_DIR}/redis.gpg"
if [[ -f "${GPG_SRC}" && -s "${GPG_SRC}" ]]; then
  echo "Uso chiave GPG locale: ${GPG_SRC}"
  cp "${GPG_SRC}" /tmp/redis.gpg
  gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg /tmp/redis.gpg
else
  echo "Download chiave GPG da packages.redis.io..."
  curl -fsSL https://packages.redis.io/gpg | gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
fi

KEY_SIZE=$(stat -c%s /usr/share/keyrings/redis-archive-keyring.gpg)
if [[ "${KEY_SIZE}" -lt 100 ]]; then
  echo "ERRORE: chiave GPG non valida (${KEY_SIZE} bytes)"
  exit 1
fi

cp "${SCRIPT_DIR}/redis.list" /etc/apt/sources.list.d/redis.list
sed -i "s/focal/${CODENAME}/g" /etc/apt/sources.list.d/redis.list

echo "Repository configurato:"
cat /etc/apt/sources.list.d/redis.list

apt-get update
apt-get install -y redis

echo "--- Versioni installate ---"
redis-server --version
redis-cli --version

service redis-server restart || true
redis-cli ping

echo "Aggiornamento Redis completato."
