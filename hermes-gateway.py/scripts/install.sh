#!/usr/bin/env bash
# Install the Wildfire IM Hermes plugin as a directory platform plugin.

set -e

PLUGIN_DIR="${HOME}/.hermes/plugins/wildfire-platform"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Installing hermes-wildfire plugin to ${PLUGIN_DIR}..."
mkdir -p "${PLUGIN_DIR}"

# Copy source files
rsync -av --exclude='.venv' --exclude='.git' --exclude='*.egg-info' --exclude='__pycache__' \
    "${REPO_DIR}/" "${PLUGIN_DIR}/"

echo "Plugin installed. Configure credentials in ~/.hermes/.env, then enable:"
echo "  hermes plugins enable wildfire-platform"
echo "  hermes gateway restart"
