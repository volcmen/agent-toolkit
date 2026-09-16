#!/bin/sh
end=$(( $(date +%s) + ${BENCH_SECONDS:-10} ))
while [ "$(date +%s)" -lt "$end" ]; do printf "tick %s  lorem ipsum dolor sit amet consectetur\n" "$(date +%S)"; sleep 0.5; done
