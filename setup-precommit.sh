#!/bin/bash

# Setup script for pre-commit hooks (see .pre-commit-config.yaml).
set -e

if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required but not installed."
    exit 1
fi

echo "Installing pre-commit..."
pip3 install pre-commit

echo "Installing git hooks..."
pre-commit install

echo "Running pre-commit on all files..."
pre-commit run --all-files

echo "Pre-commit setup complete. Hooks run on every commit;"
echo "run manually with: pre-commit run --all-files"
