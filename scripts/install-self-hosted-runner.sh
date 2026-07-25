#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/moukpu/minecraft-bot"
RUNNER_NAME="aws-minecraft-bot"
RUNNER_LABELS="minecraft-bot,aws"
RUNNER_DIR="/home/ubuntu/actions-runner-minecraft-bot"

if [ "$(id -un)" != "ubuntu" ]; then
  echo "Запусти скрипт под пользователем ubuntu."
  exit 1
fi

sudo apt update
sudo apt install -y curl tar gzip rsync ca-certificates python3

mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

if [ -f .runner ]; then
  echo "GitHub runner уже зарегистрирован. Проверяю сервис..."
  sudo ./svc.sh start || true
  sudo ./svc.sh status || true
  exit 0
fi

RUNNER_VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')"
ARCHIVE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
DOWNLOAD_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${ARCHIVE}"

echo "Скачиваю GitHub Actions Runner ${RUNNER_VERSION}..."
curl -fL "$DOWNLOAD_URL" -o "$ARCHIVE"
tar xzf "$ARCHIVE"
rm -f "$ARCHIVE"

sudo ./bin/installdependencies.sh

read -rsp "Вставь registration token из GitHub и нажми Enter: " RUNNER_TOKEN
echo

if [ -z "$RUNNER_TOKEN" ]; then
  echo "Токен пустой. Установка остановлена."
  exit 1
fi

./config.sh \
  --url "$REPO_URL" \
  --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --work "_work" \
  --unattended \
  --replace

unset RUNNER_TOKEN

echo '$nrconf{override_rc}{qr(^actions\.runner\..+\.service$)} = 0;' | sudo tee /etc/needrestart/conf.d/actions_runner_services.conf >/dev/null

sudo ./svc.sh install ubuntu
sudo ./svc.sh start
sudo ./svc.sh status

echo
echo "✅ Runner установлен. Теперь каждый push в main автоматически обновит /home/ubuntu/minecraft-bot и перезапустит PM2."
