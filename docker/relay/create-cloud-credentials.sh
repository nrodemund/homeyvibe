#!/bin/sh
set -eu

cd "$(dirname "$0")"
umask 077
mkdir cloud-credentials
trap 'rm -f cloud-credentials/token cloud-credentials/control.key cloud-credentials/control.crt; rmdir cloud-credentials' EXIT
openssl rand -hex 32 > cloud-credentials/token
openssl req -x509 -newkey rsa:2048 -nodes -days 730 \
  -subj '/CN=homeyvibe-relay' \
  -addext 'subjectAltName=DNS:homeyvibe-relay' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'extendedKeyUsage=serverAuth' \
  -keyout cloud-credentials/control.key \
  -out cloud-credentials/control.crt
trap - EXIT
printf '%s\n' 'Copy cloud-credentials/control.crt and cloud-credentials/token to the Pi over SSH.'
