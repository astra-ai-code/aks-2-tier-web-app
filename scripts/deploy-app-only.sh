#!/bin/bash
# App-only deploy: infra already provisioned by Terraform. Reads outputs (no apply),
# builds/pushes images to ACR, installs ingress, applies k8s manifests, prints URL.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d%H%M%S)}"
export PATH="$HOME/.local/bin:$PATH"
export KUBECONFIG="${KUBECONFIG:-/tmp/aks-kubeconfig}"

log()  { echo "[$(date +%H:%M:%S)] $*"; }

# ── 1. Read Terraform outputs (no apply) ──────────────────────────────────────
log "=== Reading Terraform outputs ==="
cd "$ROOT_DIR/terraform"
ACR_LOGIN_SERVER=$(terraform output -raw acr_login_server)
ACR_NAME=$(terraform output -raw acr_name)
AKS_CLUSTER=$(terraform output -raw aks_cluster_name)
RESOURCE_GROUP=$(terraform output -raw resource_group_name)
DB_HOST=$(terraform output -raw db_host)
DB_NAME=$(terraform output -raw db_name)
DB_USER=$(terraform output -raw db_username)
DB_PASS=$(terraform output -raw db_password)
log "ACR: $ACR_LOGIN_SERVER  AKS: $AKS_CLUSTER  DB: $DB_HOST"

# ── 2. Build & Push Images ────────────────────────────────────────────────────
log "=== Building and pushing images (tag: $IMAGE_TAG) ==="
# az acr login's internal docker detection misfires in WSL; use token-based docker login instead
ACR_TOKEN=$(az acr login --name "$ACR_NAME" --expose-token --query accessToken -o tsv)
echo "$ACR_TOKEN" | docker login "$ACR_LOGIN_SERVER" --username 00000000-0000-0000-0000-000000000000 --password-stdin
docker build -t "$ACR_LOGIN_SERVER/backend:$IMAGE_TAG"  -t "$ACR_LOGIN_SERVER/backend:latest"  "$ROOT_DIR/backend"
docker build -t "$ACR_LOGIN_SERVER/frontend:$IMAGE_TAG" -t "$ACR_LOGIN_SERVER/frontend:latest" "$ROOT_DIR/frontend"
docker push "$ACR_LOGIN_SERVER/backend:$IMAGE_TAG"
docker push "$ACR_LOGIN_SERVER/backend:latest"
docker push "$ACR_LOGIN_SERVER/frontend:$IMAGE_TAG"
docker push "$ACR_LOGIN_SERVER/frontend:latest"
log "Images pushed."

# ── 3. AKS Credentials ───────────────────────────────────────────────────────
log "=== Fetching AKS credentials ==="
az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$AKS_CLUSTER" --overwrite-existing
# Windows az.exe writes kubeconfig to the Windows %USERPROFILE%\.kube\config; copy into our Linux KUBECONFIG
WIN_KUBECONFIG="/mnt/c/Users/Balaji/.kube/config"
[ -f "$WIN_KUBECONFIG" ] && cp "$WIN_KUBECONFIG" "$KUBECONFIG"
kubectl config use-context "$AKS_CLUSTER"
kubectl get nodes

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
kubectl create secret generic db-secret \
  --namespace webapp \
  --from-literal=DB_HOST="$DB_HOST" \
  --from-literal=DB_PASSWORD="$DB_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f configmap.yaml
sed "s|<ACR_LOGIN_SERVER>|$ACR_LOGIN_SERVER|g; s|<IMAGE_TAG>|$IMAGE_TAG|g" backend-deployment.yaml  | kubectl apply -f -
sed "s|<ACR_LOGIN_SERVER>|$ACR_LOGIN_SERVER|g; s|<IMAGE_TAG>|$IMAGE_TAG|g" frontend-deployment.yaml | kubectl apply -f -
kubectl apply -f ingress.yaml
kubectl apply -f hpa.yaml
kubectl apply -f pdb.yaml
kubectl apply -f networkpolicy.yaml

# ── 6. Wait for rollout ───────────────────────────────────────────────────────
log "=== Waiting for deployments ==="
kubectl rollout status deployment/backend-deployment  -n webapp --timeout=240s
kubectl rollout status deployment/frontend-deployment -n webapp --timeout=240s

# ── 7. Get App URL ────────────────────────────────────────────────────────────
log "=== Waiting for NGINX Ingress external IP ==="
INGRESS_IP=""
for i in $(seq 1 30); do
  INGRESS_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  [ -n "$INGRESS_IP" ] && break
  log "Waiting for external IP... ($i/30)"
  sleep 10
done

echo ""
echo "============================================================"
echo "  DEPLOYMENT COMPLETE"
echo "  App URL:     http://$INGRESS_IP"
echo "  AKS Cluster: $AKS_CLUSTER"
echo "  Resource RG: $RESOURCE_GROUP"
echo "  ACR:         $ACR_LOGIN_SERVER"
echo "  Image Tag:   $IMAGE_TAG"
echo "============================================================"
