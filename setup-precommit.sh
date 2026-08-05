#!/bin/bash

# Setup script for the presubmit lint hooks (see .pre-commit-config.yaml).
#
# The lint gate is run by prek — a single-binary, drop-in reimplementation of
# pre-commit that reads the same .pre-commit-config.yaml. Agent containers
# install it automatically (.claude-container-overlay/), and CI runs the same
# binary (.github/workflows/test.yaml); this script is for humans setting up a
# local checkout. Once installed, the hooks run on every `git commit`.
set -e

PREK_VERSION=0.4.12

if command -v prek &> /dev/null; then
    echo "prek already installed: $(prek --version)"
else
    echo "Installing prek ${PREK_VERSION}..."
    if command -v uv &> /dev/null; then
        uv tool install "prek==${PREK_VERSION}"
    elif command -v pipx &> /dev/null; then
        pipx install "prek==${PREK_VERSION}"
    elif command -v pip3 &> /dev/null; then
        pip3 install "prek==${PREK_VERSION}"
    else
        echo "Error: need one of uv, pipx, or pip3 to install prek."
        echo "See https://github.com/j178/prek for other install methods."
        exit 1
    fi
fi

echo "Installing git hooks..."
prek install --prepare-hooks

echo "Running lints on all files..."
prek run --all-files

echo "Presubmit setup complete. Hooks run on every commit;"
echo "run manually with: prek run --all-files"
