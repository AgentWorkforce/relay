#!/bin/sh
set -eu

runner_temp=$1
trusted_verifier=$2
candidate_root=$3
candidate_cwd=$4
node_binary=$5
shift 5

mount --make-rprivate /
mkdir -p /mnt/relay-candidate-root /mnt/relay-candidate-cwd
mount --bind "$candidate_root" /mnt/relay-candidate-root
mount -o remount,bind,ro /mnt/relay-candidate-root
mount --bind "$candidate_cwd" /mnt/relay-candidate-cwd

# Hide the runner's shared temporary directory, then put back only the
# candidate install and its disposable working directory. Credential files
# created beside the install are therefore absent from the candidate mount.
mount -t tmpfs -o mode=0700,nosuid,nodev tmpfs "$runner_temp"
mount -t tmpfs -o mode=0700,nosuid,nodev tmpfs "$trusted_verifier"
mkdir -p "$candidate_root" "$candidate_cwd"
mount --bind /mnt/relay-candidate-root "$candidate_root"
mount -o remount,bind,ro "$candidate_root"
mount --bind /mnt/relay-candidate-cwd "$candidate_cwd"
mount -o remount,bind,rw "$candidate_cwd"
cd "$candidate_cwd"
exec "$node_binary" "$@"
