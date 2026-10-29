export const COMMAND_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export const COMMAND_JOB_START_SCRIPT = `
set -u
command_job_id="$1"
command_text="$2"
maximum_output_bytes="$3"
timeout_seconds="$4"
jobs_directory=/tmp/cutebots-command-jobs
job_directory="$jobs_directory/$command_job_id"

mkdir -p "$jobs_directory"
find "$jobs_directory" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf -- {} + 2>/dev/null || true
mkdir -p "$job_directory"
date +%s > "$job_directory/created"
printf running > "$job_directory/status"
: > "$job_directory/output"

setsid bash -lc "$command_text" > "$job_directory/output" 2>&1 &
command_process_id=$!
printf '%s' "$command_process_id" > "$job_directory/pid"
(
  command_started_at=$(date +%s)
  while kill -0 "$command_process_id" 2>/dev/null; do
    current_time=$(date +%s)
    elapsed_seconds=$((current_time - command_started_at))
    if [ "$elapsed_seconds" -ge "$timeout_seconds" ]; then
      : > "$job_directory/timed-out"
      kill -TERM -- "-$command_process_id" 2>/dev/null || true
      sleep 5
      kill -KILL -- "-$command_process_id" 2>/dev/null || true
      break
    fi

    output_size_bytes=$(wc -c < "$job_directory/output")
    if [ "$output_size_bytes" -gt "$maximum_output_bytes" ]; then
      head -c "$maximum_output_bytes" "$job_directory/output" > "$job_directory/output.trimmed"
      mv "$job_directory/output.trimmed" "$job_directory/output"
      : > "$job_directory/truncated"
    fi
    sleep 1
  done
) &
monitor_process_id=$!
wait "$command_process_id"
exit_code=$?
kill "$monitor_process_id" 2>/dev/null || true
wait "$monitor_process_id" 2>/dev/null || true

output_size_bytes=$(wc -c < "$job_directory/output")
if [ "$output_size_bytes" -gt "$maximum_output_bytes" ]; then
  head -c "$maximum_output_bytes" "$job_directory/output" > "$job_directory/output.trimmed"
  mv "$job_directory/output.trimmed" "$job_directory/output"
  : > "$job_directory/truncated"
fi

printf '%s' "$exit_code" > "$job_directory/exit"
if [ -f "$job_directory/timed-out" ]; then
  printf timed_out > "$job_directory/status"
elif [ -f "$job_directory/cancel-requested" ]; then
  printf cancelled > "$job_directory/status"
elif [ "$exit_code" -eq 0 ]; then
  printf completed > "$job_directory/status"
else
  printf failed > "$job_directory/status"
fi
`;

export const COMMAND_JOB_POLL_SCRIPT = `
set -u
command_job_id="$1"
output_offset="$2"
maximum_output_bytes="$3"
max_age_ms="$4"
job_directory="/tmp/cutebots-command-jobs/$command_job_id"

if [ ! -d "$job_directory" ]; then
  printf 'Unknown or expired command job' >&2
  exit 2
fi
created_at=$(cat "$job_directory/created")
current_time=$(date +%s)
job_age_seconds=$((current_time - created_at))
maximum_age_seconds=$((max_age_ms / 1000))
if [ "$job_age_seconds" -gt "$maximum_age_seconds" ]; then
  rm -rf -- "$job_directory"
  printf 'Unknown or expired command job' >&2
  exit 2
fi

output_size_bytes=$(wc -c < "$job_directory/output")
available_output_bytes=$((output_size_bytes - output_offset))
if [ "$available_output_bytes" -lt 0 ]; then
  available_output_bytes=0
fi
if [ "$available_output_bytes" -gt "$maximum_output_bytes" ]; then
  available_output_bytes="$maximum_output_bytes"
fi
if [ "$available_output_bytes" -gt 0 ]; then
  output_base64=$(tail -c "+$((output_offset + 1))" "$job_directory/output" | head -c "$available_output_bytes" | base64 -w 0)
else
  output_base64=""
fi

command_status=$(cat "$job_directory/status")
exit_code=null
if [ -f "$job_directory/exit" ]; then
  exit_code=$(cat "$job_directory/exit")
fi
output_truncated=false
if [ -f "$job_directory/truncated" ]; then
  output_truncated=true
fi
printf '{"jobId":"%s","status":"%s","outputBase64":"%s","nextOffset":%s,"exitCode":%s,"outputTruncated":%s}' \\
  "$command_job_id" "$command_status" "$output_base64" "$((output_offset + available_output_bytes))" "$exit_code" "$output_truncated"
`;

export const COMMAND_JOB_CANCEL_SCRIPT = `
set -u
command_job_id="$1"
job_directory="/tmp/cutebots-command-jobs/$command_job_id"

if [ ! -d "$job_directory" ]; then
  printf 'Unknown or expired command job' >&2
  exit 2
fi

if [ "$(cat "$job_directory/status")" != running ]; then
  exit 0
fi

: > "$job_directory/cancel-requested"
command_process_id=$(cat "$job_directory/pid")
kill -TERM -- "-$command_process_id" 2>/dev/null || true
for attempt in $(seq 1 50); do
  if ! kill -0 -- "-$command_process_id" 2>/dev/null; then
    exit 0
  fi
  sleep 0.1
done
kill -KILL -- "-$command_process_id" 2>/dev/null || true
`;

export const COMMAND_JOB_CLEANUP_SCRIPT = `
set -u
jobs_directory=/tmp/cutebots-command-jobs
if [ ! -d "$jobs_directory" ]; then
  exit 0
fi

for job_directory in "$jobs_directory"/*; do
  [ -d "$job_directory" ] || continue
  [ -f "$job_directory/status" ] || continue
  [ "$(cat "$job_directory/status")" = running ] || continue

  if [ ! -f "$job_directory/pid" ]; then
    printf 'Running command job has no process ID: %s\\n' "$job_directory" >&2
    exit 1
  fi
  command_process_id=$(cat "$job_directory/pid")
  case "$command_process_id" in
    ''|*[!0-9]*)
      printf 'Running command job has an invalid process ID: %s\\n' "$job_directory" >&2
      exit 1
      ;;
  esac
  if [ "$command_process_id" -le 1 ]; then
    printf 'Running command job has an unsafe process ID: %s\\n' "$job_directory" >&2
    exit 1
  fi
  process_group_id=$(ps -o pgid= -p "$command_process_id" | tr -d ' ')
  if [ -n "$process_group_id" ] && [ "$process_group_id" != "$command_process_id" ]; then
    printf 'Running command job process group does not match its process ID: %s\\n' "$job_directory" >&2
    exit 1
  fi

  : > "$job_directory/cancel-requested"
  kill -TERM -- "-$command_process_id" 2>/dev/null || true
  process_stopped=false
  for attempt in $(seq 1 50); do
    if ! kill -0 -- "-$command_process_id" 2>/dev/null; then
      process_stopped=true
      break
    fi
    sleep 0.1
  done
  if [ "$process_stopped" != true ]; then
    kill -KILL -- "-$command_process_id" 2>/dev/null || true
    if kill -0 -- "-$command_process_id" 2>/dev/null; then
      printf 'Unable to stop command process group: %s\\n' "$job_directory" >&2
      exit 1
    fi
  fi

  job_stopped=false
  for attempt in $(seq 1 50); do
    if [ "$(cat "$job_directory/status")" != running ]; then
      job_stopped=true
      break
    fi
    sleep 0.1
  done
  if [ "$job_stopped" != true ]; then
    printf cancelled > "$job_directory/status"
  fi
done
`;
