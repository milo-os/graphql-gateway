#!/bin/bash
set -e

# =============================================================================
# GraphQL Gateway Local Test Setup Script
# =============================================================================
# This script sets up everything needed to test the gateway locally with mTLS.
#
# Prerequisites:
#   - kubectl configured to access a cluster with milo-apiserver
#   - cert-manager installed in the cluster
#   - datum-control-plane ClusterIssuer configured
#
# Usage:
#   ./scripts/local-test.sh          # Full setup + run gateway
#   ./scripts/local-test.sh setup    # Only setup (no gateway)
#   ./scripts/local-test.sh run      # Only run gateway (assumes setup done)
#   ./scripts/local-test.sh clean    # Cleanup
# =============================================================================

# Required kubectl context
REQUIRED_CONTEXT="gke_datum-cloud-staging_us-east4_infrastructure-control-plane-staging"

# Check kubectl context before doing anything
check_kubectl_context() {
  local current_context
  current_context=$(kubectl config current-context 2>/dev/null)
  
  if [ -z "$current_context" ]; then
    echo -e "\033[0;31m[ERROR]\033[0m Unable to get current kubectl context. Is kubectl configured?"
    exit 1
  fi
  
  if [ "$current_context" != "$REQUIRED_CONTEXT" ]; then
    echo -e "\033[0;31m[ERROR]\033[0m Wrong kubectl context!"
    echo ""
    echo "  Current context:  $current_context"
    echo "  Required context: $REQUIRED_CONTEXT"
    echo ""
    echo "Please switch to the correct context:"
    echo "  kubectl config use-context $REQUIRED_CONTEXT"
    echo ""
    exit 1
  fi
  
  echo -e "\033[0;32m[INFO]\033[0m kubectl context verified: $current_context"
}

# Run context check immediately (except for help command)
if [ "${1:-}" != "--help" ] && [ "${1:-}" != "-h" ]; then
  check_kubectl_context
fi

LOCAL_DIR="/tmp/graphql-gateway-test"
NAMESPACE="${NAMESPACE:-datum-system}"
CERT_NAMESPACE="${CERT_NAMESPACE:-default}"
CERT_NAME="graphql-gateway-local-test"
APISERVER_HOST="milo-apiserver"
APISERVER_PORT="6443"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# =============================================================================
# Setup Functions
# =============================================================================

start_lgtm() {
  log_info "Checking Grafana LGTM container..."
  
  # Get the script directory for mounting grafana configs
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
  
  # Create Prometheus config to scrape gateway metrics
  PROM_CONFIG="$LOCAL_DIR/prometheus.yaml"
  cat > "$PROM_CONFIG" << 'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  # Scrape GraphQL Gateway metrics
  - job_name: 'graphql-gateway'
    scheme: https
    tls_config:
      insecure_skip_verify: true
    static_configs:
      - targets: ['host.docker.internal:4000']
    metrics_path: /metrics
    scrape_interval: 10s
EOF
  
  # Check if lgtm container exists
  if docker ps -a --format '{{.Names}}' | grep -q '^lgtm$'; then
    # Container exists, check if running
    if docker ps --format '{{.Names}}' | grep -q '^lgtm$'; then
      log_info "Grafana LGTM is already running"
    else
      log_info "Starting existing Grafana LGTM container..."
      docker start lgtm
    fi
  else
    log_info "Creating and starting Grafana LGTM container..."
    # Grafana LGTM: Loki (logs), Grafana (UI), Tempo (traces), Mimir (metrics)
    # Ports:
    #   3000: Grafana UI
    #   4317: OTLP gRPC (traces & metrics)
    #   4318: OTLP HTTP (traces & metrics)
    #   9090: Prometheus metrics endpoint
    docker run -d --name lgtm \
      -p 3000:3000 \
      -p 4317:4317 \
      -p 4318:4318 \
      -p 9090:9090 \
      -v "$PROM_CONFIG:/otel-lgtm/prometheus.yaml:ro" \
      -v "$PROJECT_DIR/grafana/provisioning/dashboards/default.yaml:/otel-lgtm/grafana/conf/provisioning/dashboards/custom.yaml:ro" \
      -v "$PROJECT_DIR/grafana/provisioning/datasources/default.yaml:/otel-lgtm/grafana/conf/provisioning/datasources/custom.yaml:ro" \
      -v "$PROJECT_DIR/config:/app/config:ro" \
      -e GF_AUTH_ANONYMOUS_ENABLED=true \
      -e GF_AUTH_ANONYMOUS_ORG_ROLE=Admin \
      -e GF_AUTH_DISABLE_LOGIN_FORM=true \
      grafana/otel-lgtm:0.15.0
  fi
  
  # Wait for LGTM to be ready
  sleep 3
  log_info "Grafana LGTM is starting..."
  log_info "  Grafana UI:     http://localhost:3000"
  log_info "  OTLP gRPC:      localhost:4317"
  log_info "  OTLP HTTP:      localhost:4318"
  log_info "  Prometheus:     http://localhost:9090"
  log_info "  Scraping metrics from: http://localhost:4000/metrics"
  log_info "  Dashboards loaded from: $PROJECT_DIR/config/components/observability/dashboards/grafana/"
}

setup_directories() {
  log_info "Creating local directory structure..."
  mkdir -p "$LOCAL_DIR/pki/client"
  mkdir -p "$LOCAL_DIR/pki/trust"
  mkdir -p "$LOCAL_DIR/config"
  log_info "Directories created at $LOCAL_DIR"
}

extract_ca_cert() {
  log_info "Extracting CA certificate from cluster..."
  
  # Try different ConfigMap names
  for cm_name in "datum-control-plane-trust-bundle" "trust-bundle" "datum-control-plane-system-bundle"; do
    if kubectl get configmap "$cm_name" -n "$NAMESPACE" &>/dev/null; then
      kubectl get configmap "$cm_name" -n "$NAMESPACE" -o jsonpath='{.data.ca\.crt}' > "$LOCAL_DIR/pki/trust/ca.crt"
      log_info "CA certificate extracted from ConfigMap: $cm_name"
      return 0
    fi
  done
  
  log_error "Could not find CA certificate ConfigMap. Please manually copy CA to: $LOCAL_DIR/pki/trust/ca.crt"
  return 1
}

create_client_cert() {
  log_info "Creating client certificate..."
  
  # Check if certificate already exists
  if kubectl get certificate "$CERT_NAME" -n "$CERT_NAMESPACE" &>/dev/null; then
    log_info "Certificate $CERT_NAME already exists, checking if ready..."
  else
    log_info "Creating Certificate resource..."
    cat << EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: $CERT_NAME
  namespace: $CERT_NAMESPACE
spec:
  secretName: ${CERT_NAME}-cert
  issuerRef:
    name: datum-control-plane
    kind: ClusterIssuer
  commonName: graphql-gateway-local
  usages:
    - client auth
  duration: 24h
EOF
  fi
  
  # Wait for certificate to be ready
  log_info "Waiting for certificate to be ready..."
  if ! kubectl wait --for=condition=Ready certificate/"$CERT_NAME" -n "$CERT_NAMESPACE" --timeout=120s; then
    log_error "Certificate not ready. Check cert-manager logs."
    kubectl describe certificate "$CERT_NAME" -n "$CERT_NAMESPACE"
    return 1
  fi
  
  log_info "Certificate is ready!"
}

extract_client_cert() {
  log_info "Extracting client certificates..."
  
  SECRET_NAME="${CERT_NAME}-cert"
  
  kubectl get secret "$SECRET_NAME" -n "$CERT_NAMESPACE" -o jsonpath='{.data.tls\.crt}' | base64 -d > "$LOCAL_DIR/pki/client/tls.crt"
  kubectl get secret "$SECRET_NAME" -n "$CERT_NAMESPACE" -o jsonpath='{.data.tls\.key}' | base64 -d > "$LOCAL_DIR/pki/client/tls.key"
  
  log_info "Client certificates extracted to $LOCAL_DIR/pki/client/"
}

create_kubeconfig() {
  log_info "Creating local kubeconfig..."
  
  cat > "$LOCAL_DIR/config/kubeconfig" << EOF
apiVersion: v1
clusters:
- cluster:
    certificate-authority: $LOCAL_DIR/pki/trust/ca.crt
    server: https://${APISERVER_HOST}:${APISERVER_PORT}
  name: milo-apiserver
contexts:
- context:
    cluster: milo-apiserver
    user: graphql-gateway-local
  name: local
current-context: local
kind: Config
preferences: {}
users:
- name: graphql-gateway-local
  user:
    client-certificate: $LOCAL_DIR/pki/client/tls.crt
    client-key: $LOCAL_DIR/pki/client/tls.key
EOF

  log_info "Kubeconfig created at $LOCAL_DIR/config/kubeconfig"
}

setup_hosts_entry() {
  log_info "Checking /etc/hosts for $APISERVER_HOST entry..."
  
  if grep -q "$APISERVER_HOST" /etc/hosts; then
    log_info "Host entry for $APISERVER_HOST already exists"
  else
    log_warn "Need to add $APISERVER_HOST to /etc/hosts (requires sudo)"
    echo ""
    echo "Please run this command manually:"
    echo "  sudo sh -c 'echo \"127.0.0.1 $APISERVER_HOST\" >> /etc/hosts'"
    echo ""
    read -p "Press Enter after adding the hosts entry (or Ctrl+C to cancel)..."
    
    if ! grep -q "$APISERVER_HOST" /etc/hosts; then
      log_error "Host entry not found. Please add it manually."
      return 1
    fi
  fi
}

start_port_forward() {
  log_info "Starting port-forward to milo-apiserver..."
  
  # Kill any existing port-forward
  pkill -f "kubectl port-forward.*milo-apiserver.*${APISERVER_PORT}" 2>/dev/null || true
  sleep 1
  
  # Start port-forward in background
  kubectl port-forward -n "$NAMESPACE" svc/milo-apiserver "${APISERVER_PORT}:${APISERVER_PORT}" &
  PF_PID=$!
  
  # Wait for port-forward to be ready
  sleep 3
  
  if ! kill -0 $PF_PID 2>/dev/null; then
    log_error "Port-forward failed to start"
    return 1
  fi
  
  log_info "Port-forward started (PID: $PF_PID)"
  echo "$PF_PID" > "$LOCAL_DIR/port-forward.pid"
}

verify_connection() {
  log_info "Verifying mTLS connection..."
  
  if curl -sk --cert "$LOCAL_DIR/pki/client/tls.crt" \
              --key "$LOCAL_DIR/pki/client/tls.key" \
              --cacert "$LOCAL_DIR/pki/trust/ca.crt" \
              "https://${APISERVER_HOST}:${APISERVER_PORT}/healthz" | grep -q "ok"; then
    log_info "mTLS connection verified successfully!"
    return 0
  else
    log_warn "Could not verify connection (this might be okay, healthz endpoint may not exist)"
    return 0
  fi
}

create_server_cert() {
  log_info "Creating self-signed server certificate for localhost..."
  
  cert_dir="$LOCAL_DIR/pki/serving"
  mkdir -p "$cert_dir"
  
  openssl req -x509 -newkey rsa:4096 -sha256 -days 365 \
    -nodes -keyout "$cert_dir/tls.key" -out "$cert_dir/tls.crt" \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    2>/dev/null
    
  log_info "Server certificate created at $cert_dir"
}

run_gateway() {
  log_info "Starting GraphQL Gateway..."
  echo ""
  echo "========================================="
  echo "Gateway Configuration:"
  echo "  KUBECONFIG: $LOCAL_DIR/config/kubeconfig"
  echo "  CA Cert: $LOCAL_DIR/pki/trust/ca.crt"
  echo "  Server: https://${APISERVER_HOST}:${APISERVER_PORT}"
  echo "  HTTPS Certs: $LOCAL_DIR/pki/serving"
  echo "========================================="
  echo ""
  
  cd "$(dirname "$0")/.."
  
  npm install
  
  NODE_EXTRA_CA_CERTS="$LOCAL_DIR/pki/trust/ca.crt" \
  KUBECONFIG="$LOCAL_DIR/config/kubeconfig" \
  OTLP_URL="${OTLP_URL:-localhost:4317}" \
  CERT_DIR="$LOCAL_DIR/pki/serving" \
  npm run dev
}

# =============================================================================
# Cleanup Function
# =============================================================================

cleanup() {
  log_info "Cleaning up..."
  
  # Stop port-forward
  if [ -f "$LOCAL_DIR/port-forward.pid" ]; then
    PID=$(cat "$LOCAL_DIR/port-forward.pid")
    kill "$PID" 2>/dev/null || true
    rm "$LOCAL_DIR/port-forward.pid"
    log_info "Stopped port-forward"
  fi
  
  # Delete certificate
  if kubectl get certificate "$CERT_NAME" -n "$CERT_NAMESPACE" &>/dev/null; then
    kubectl delete certificate "$CERT_NAME" -n "$CERT_NAMESPACE"
    kubectl delete secret "${CERT_NAME}-cert" -n "$CERT_NAMESPACE" 2>/dev/null || true
    log_info "Deleted certificate and secret"
  fi
  
  # Remove local directory
  if [ -d "$LOCAL_DIR" ]; then
    rm -rf "$LOCAL_DIR"
    log_info "Removed $LOCAL_DIR"
  fi
  
  log_info "Cleanup complete!"
  echo ""
  echo "Note: You may want to remove the /etc/hosts entry manually:"
  echo "  sudo sed -i '' '/$APISERVER_HOST/d' /etc/hosts"
}

# =============================================================================
# Full Setup
# =============================================================================

full_setup() {
  echo ""
  echo "========================================="
  echo " GraphQL Gateway Local Test Setup"
  echo "========================================="
  echo ""
  
  setup_directories
  start_lgtm
  extract_ca_cert
  create_client_cert
  extract_client_cert
  create_server_cert
  create_kubeconfig
  setup_hosts_entry
  start_port_forward
  verify_connection
  
  echo ""
  log_info "Setup complete!"
  echo ""
}

# =============================================================================
# Main
# =============================================================================

case "${1:-all}" in
  setup)
    full_setup
    echo "Run './scripts/local-test.sh run' to start the gateway"
    ;;
  run)
    if [ ! -f "$LOCAL_DIR/config/kubeconfig" ]; then
      log_error "Setup not complete. Run './scripts/local-test.sh setup' first"
      exit 1
    fi
    
    # Start LGTM if not running
    start_lgtm
    
    # Start port-forward if not running
    if [ ! -f "$LOCAL_DIR/port-forward.pid" ] || ! kill -0 $(cat "$LOCAL_DIR/port-forward.pid") 2>/dev/null; then
      start_port_forward
    fi
    
    run_gateway
    ;;
  clean|cleanup)
    cleanup
    ;;
  all|"")
    full_setup
    run_gateway
    ;;
  *)
    echo "Usage: $0 [setup|run|clean|all]"
    echo ""
    echo "Commands:"
    echo "  setup  - Set up certificates and configuration only"
    echo "  run    - Run the gateway (assumes setup is done)"
    echo "  clean  - Clean up all resources"
    echo "  all    - Full setup + run gateway (default)"
    exit 1
    ;;
esac
