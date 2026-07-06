#!/usr/bin/env bash

DIR="${XDG_CONFIG_HOME:=$HOME/.config}/shojiwm"
export YDOTOOL_SOCKET="/tmp/shojiwm.hotreload.ydotool.socket"

if ! command -v inotifywait &>/dev/null; then
  echo -e "\x1b[31mErr:\x1b[0m inotifywait (inotify-tools) is not available"
  exit 1
fi
if ! command -v ydotool &>/dev/null; then
  echo -e "\x1b[31mErr:\x1b[0m ydotool is not available"
  exit 1
fi
if ! command -v ydotoold &>/dev/null; then
  echo -e "\x1b[31mErr:\x1b[0m ydotoold is not available"
  exit 1
fi
if [ ! -d "$DIR" ]; then
  echo -e "\x1b[31mErr:\x1b[0m Directory $DIR does not exist"
  exit 2
fi

sudo ydotoold --socket-path="$YDOTOOL_SOCKET" --socket-own="$(id -u):$(id -g)" &>/dev/null &
YDOTOOLD_PID=$!

exec 3< <(inotifywait -m -r -e create -e modify -e delete "$DIR" 2>/dev/null)
INOTIFYWAIT_PID=$!

cleanup() {
  sudo kill -TERM "$YDOTOOLD_PID" 2>/dev/null
  sudo kill -TERM "$INOTIFYWAIT_PID" 2>/dev/null
}
trap 'cleanup; exit' EXIT SIGINT SIGTERM

echo -e "\x1b[34mInf:\x1b[0m Watching $DIR"

while read -r -u 3 _ _ _; do
  echo -e "\x1b[34mInf:\x1b[0m Change detected in $DIR"

  # Debounce
  while read -r -u 3 -t 0.3 _ _ _; do :; done

  if command -v ydotool &>/dev/null; then
    ydotool key --key-delay 20 125:1 42:1 19:1 19:0 42:0 125:0
  else
    echo -e "\x1b[31mErr:\x1b[0m ydotool exited with an error"
    exit 3
  fi
done
