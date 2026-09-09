#!/bin/sh
set -eu

runner_temp=$1
candidate_root=$2
candidate_cwd=$3
node_binary=$4
shift 4

mount --make-rprivate /
mkdir -p /mnt/relay-candidate-root /mnt/relay-candidate-cwd
mount --bind "$candidate_root" /mnt/relay-candidate-root
mount --bind "$candidate_cwd" /mnt/relay-candidate-cwd

# Hide the runner's shared temporary directory, then put back only the
# candidate install and its disposable working directory. Credential files
# created beside the install are therefore absent from the candidate mount.
mount -t tmpfs -o mode=0700,nosuid,nodev tmpfs "$runner_temp"
mkdir -p "$candidate_root" "$candidate_cwd"
mount --bind /mnt/relay-candidate-root "$candidate_root"
mount --bind /mnt/relay-candidate-cwd "$candidate_cwd"
cd "$candidate_cwd"
exec "$node_binary" "$@"
