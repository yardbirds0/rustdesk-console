#!/bin/sh
set -eu

case "${1:-}" in
  --system-update-mode=*) set -- node /app/dist/main.js "$@" ;;
esac
if [ "${SYSTEM_UPDATE_ROLE:-}" = updater ]; then
  umask 077
  state=$(dirname -- "$SYSTEM_UPDATE_INSTALLATION")
  ipc=$(dirname -- "$SYSTEM_UPDATE_SOCKET")
  maintenance=$(dirname -- "$SYSTEM_UPDATE_MAINTENANCE_FILE")
  mkdir -p "$state" "$ipc" "$maintenance"
  chmod 700 "$state"
  chown "0:${SYSTEM_UPDATE_SOCKET_GID:-1000}" "$ipc"
  chmod 750 "$ipc"
  chmod 755 "$maintenance"
  exec "$@"
fi
case " $* " in
  *" --system-update-mode=updater "*|*" --system-update-mode=worker "*|*" --system-update-mode=recover "*)
    umask 077
    # Workers inherit only verified mount paths from their installation record.
    exec "$@"
    ;;
esac

if [ "$(id -u)" = 0 ]; then
  mkdir -p "${DATA_DIR:-/data}"
  find "${DATA_DIR:-/data}" -xdev \( \! -user 1000 -o \! -group 1000 \) \
    -exec chown -h 1000:1000 {} +
  exec su-exec 1000:1000 "$@"
fi
exec "$@"
