#!/bin/sh
set -e
# Export so envsubst can read it; default to K8s service name
export BACKEND_HOST="${BACKEND_HOST:-backend-service:3001}"
envsubst '${BACKEND_HOST}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
