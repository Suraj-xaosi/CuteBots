export const COMMAND_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export const COMMAND_JOB_START_SCRIPT = `
set -u
job_id="$1"
command="$2"
output_limit="$3"
timeout_seconds="$4"
root=/tmp/cutebots-command-jobs
directory="$root/$job_id"
mkdir -p "$root"
find "$root" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf -- {} + 2>/dev/null || true
mkdir -p "$directory"
date +%s > "$directory/created"
printf running > "$directory/status"
: > "$directory/output"
setsid bash -lc "$command" > "$directory/output" 2>&1 &
child_pid=$!
printf '%s' "$child_pid" > "$directory/pid"
(
  started_at=$(date +%s)
  while kill -0 "$child_pid" 2>/dev/null; do
    now=$(date +%s)
    if [ "$((now - started_at))" -ge "$timeout_seconds" ]; then
      : > "$directory/timed-out"
      kill -TERM -- "-$child_pid" 2>/dev/null || true
      sleep 5
      kill -KILL -- "-$child_pid" 2>/dev/null || true
      break
    fi
    output_size=$(wc -c < "$directory/output")
    if [ "$output_size" -gt "$output_limit" ]; then
      head -c "$output_limit" "$directory/output" > "$directory/output.trimmed"
      mv "$directory/output.trimmed" "$directory/output"
      : > "$directory/truncated"
    fi
    sleep 1
  done
) &
monitor_pid=$!
wait "$child_pid"
exit_code=$?
kill "$monitor_pid" 2>/dev/null || true
wait "$monitor_pid" 2>/dev/null || true
output_size=$(wc -c < "$directory/output")
if [ "$output_size" -gt "$output_limit" ]; then
  head -c "$output_limit" "$directory/output" > "$directory/output.trimmed"
  mv "$directory/output.trimmed" "$directory/output"
  : > "$directory/truncated"
fi
printf '%s' "$exit_code" > "$directory/exit"
if [ -f "$directory/timed-out" ]; then
  printf timed_out > "$directory/status"
elif [ -f "$directory/cancel-requested" ]; then
  printf cancelled > "$directory/status"
elif [ "$exit_code" -eq 0 ]; then
  printf completed > "$directory/status"
else
  printf failed > "$directory/status"
fi
`;

export const COMMAND_JOB_POLL_SCRIPT = `
set -u
job_id="$1"
offset="$2"
limit="$3"
max_age_ms="$4"
directory="/tmp/cutebots-command-jobs/$job_id"
if [ ! -d "$directory" ]; then
  printf 'Unknown or expired command job' >&2
  exit 2
fi
created=$(cat "$directory/created")
now=$(date +%s)
if [ "$((now - created))" -gt "$((max_age_ms / 1000))" ]; then
  rm -rf -- "$directory"
  printf 'Unknown or expired command job' >&2
  exit 2
fi
output_size=$(wc -c < "$directory/output")
available=$((output_size - offset))
if [ "$available" -lt 0 ]; then available=0; fi
if [ "$available" -gt "$limit" ]; then available="$limit"; fi
if [ "$available" -gt 0 ]; then
  output=$(tail -c "+$((offset + 1))" "$directory/output" | head -c "$available" | base64 -w 0)
else
  output=""
fi
status=$(cat "$directory/status")
exit_code=null
if [ -f "$directory/exit" ]; then exit_code=$(cat "$directory/exit"); fi
truncated=false
if [ -f "$directory/truncated" ]; then truncated=true; fi
printf '{"jobId":"%s","status":"%s","outputBase64":"%s","nextOffset":%s,"exitCode":%s,"outputTruncated":%s}' \\
  "$job_id" "$status" "$output" "$((offset + available))" "$exit_code" "$truncated"
`;

export const COMMAND_JOB_CANCEL_SCRIPT = `
set -u
job_id="$1"
directory="/tmp/cutebots-command-jobs/$job_id"
if [ ! -d "$directory" ]; then
  printf 'Unknown or expired command job' >&2
  exit 2
fi
if [ "$(cat "$directory/status")" != running ]; then exit 0; fi
: > "$directory/cancel-requested"
child_pid=$(cat "$directory/pid")
kill -TERM -- "-$child_pid" 2>/dev/null || true
for attempt in $(seq 1 50); do
  if ! kill -0 -- "-$child_pid" 2>/dev/null; then exit 0; fi
  sleep 0.1
done
kill -KILL -- "-$child_pid" 2>/dev/null || true
`;
