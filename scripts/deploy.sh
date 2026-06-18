#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d%H%M%S)}"

log()  { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "[ERROR] $*" >&2; exit 1; }

# ── 1. Terraform ──────────────────────────────────────────────────────────────
log "=== Provisioning Azure infrastructure with Terraform ==="
cd "$ROOT_DIR/terraform"
terraform init -upgrade
terraform apply -auto-approve

ACR_LOGIN_SERVER=$(terraform output -raw acr_login_server)
ACR_NAME=$(terraform output -raw acr_name)
AKS_CLUSTER=$(terraform output -raw aks_cluster_name)
RESOURCE_GROUP=$(terraform output -raw resource_group_name)
DB_HOST=$(terraform output -raw db_host)
DB_NAME=$(terraform output -raw db_name)
DB_USER=$(terraform output -raw db_username)
DB_PASS=$(terraform output -raw db_password)

log "ACR:     $ACR_LOGIN_SERVER"
log "AKS:     $AKS_CLUSTER"
log "DB Host: $DB_HOST"

# ── 2. Build & Push Images ────────────────────────────────────────────────────
log "=== Building and pushing Docker images (tag: $IMAGE_TAG) ==="
az acr login --name "$ACR_NAME"

docker build -t "$ACR_LOGIN_SERVER/backend:$IMAGE_TAG"  -t "$ACR_LOGIN_SERVER/backend:latest"  "$ROOT_DIR/backend"
docker build -t "$ACR_LOGIN_SERVER/frontend:$IMAGE_TAG" -t "$ACR_LOGIN_SERVER/frontend:latest" "$ROOT_DIR/frontend"

docker push "$ACR_LOGIN_SERVER/backend:$IMAGE_TAG"
docker push "$ACR_LOGIN_SERVER/backend:latest"
docker push "$ACR_LOGIN_SERVER/frontend:$IMAGE_TAG"
docker push "$ACR_LOGIN_SERVER/frontend:latest"

# ── 3. AKS Credentials ───────────────────────────────────────────────────────
log "=== Fetching AKS credentials ==="
az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$AKS_CLUSTER" --overwrite-existing

# ── 4. Helm: NGINX Ingress + Metrics Server ───────────────────────────────────
log "=== Installing NGINX Ingress Controller ==="
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.replicaCount=2 \
  --set controller.service.type=LoadBalancer \
  --wait --timeout 5m

log "=== Installing metrics-server ==="
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ --force-update
helm upgrade --install metrics-server metrics-server/metrics-server \
  --namespace kube-system \
  --set args[0]="--kubelet-insecure-tls" \
  --wait --timeout 3m

log "=== Installing New Relic Kubernetes integration ==="
NR_LICENSE_KEY="${NR_LICENSE_KEY:-0ffeb2f46f681bcf88d0a0cfd158e8111d13NRAL}"
helm repo add newrelic https://helm-charts.newrelic.com --force-update
helm upgrade --install newrelic-bundle newrelic/nri-bundle \
  --namespace newrelic --create-namespace \
  -f "$ROOT_DIR/k8s/newrelic-values.yaml" \
  --set global.licenseKey="$NR_LICENSE_KEY" \
  --set global.cluster="$AKS_CLUSTER" \
  --wait --timeout 5m

# ── 5. Kubernetes Manifests ───────────────────────────────────────────────────
log "=== Applying Kubernetes manifests ==="
cd "$ROOT_DIR/k8s"

kubectl apply -f namespace.yaml

# Create DB secret
kubectl create secret generic db-secret \
  --namespace webapp \
  --from-literal=DB_HOST="$DB_HOST" \
  --from-literal=DB_PASSWORD="$DB_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f configmap.yaml

# Patch image references and apply deployments
sed "s|<ACR_LOGIN_SERVER>|$ACR_LOGIN_SERVER|g; s|<IMAGE_TAG>|$IMAGE_TAG|g" \
  backend-deployment.yaml | kubectl apply -f -

sed "s|<ACR_LOGIN_SERVER>|$ACR_LOGIN_SERVER|g; s|<IMAGE_TAG>|$IMAGE_TAG|g" \
  frontend-deployment.yaml | kubectl apply -f -

kubectl apply -f ingress.yaml
kubectl apply -f hpa.yaml
kubectl apply -f pdb.yaml
kubectl apply -f networkpolicy.yaml

# ── 6. Wait for rollout ───────────────────────────────────────────────────────
log "=== Waiting for deployments to be ready ==="
kubectl rollout status deployment/backend-deployment  -n webapp --timeout=180s
kubectl rollout status deployment/frontend-deployment -n webapp --timeout=180s

# ── 7. Get App URL ────────────────────────────────────────────────────────────
log "=== Waiting for NGINX Ingress external IP ==="
for i in $(seq 1 24); do
  INGRESS_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  [ -n "$INGRESS_IP" ] && break
  log "Waiting for external IP... ($i/24)"
  sleep 10
done

echo ""
echo "============================================================"
echo "  DEPLOYMENT COMPLETE"
echo "============================================================"
echo "  App URL:     http://$INGRESS_IP"
echo "  AKS Cluster: $AKS_CLUSTER"
echo "  Resource RG: $RESOURCE_GROUP"
echo "  ACR:         $ACR_LOGIN_SERVER"
echo "  Image Tag:   $IMAGE_TAG"
echo "============================================================"
