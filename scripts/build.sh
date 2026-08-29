#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
connector_dir="$project_dir/local.readwise.reader"
output_file="$project_dir/ReadwiseReader.tapestry"
temporary_file="$project_dir/ReadwiseReader.tapestry.tmp"

trap 'rm -f "$temporary_file"' EXIT

cd "$connector_dir"
zip -X -q "$temporary_file" plugin-config.json ui-config.json actions.json plugin.js README.md
unzip -t "$temporary_file"
mv "$temporary_file" "$output_file"

echo "Built $output_file"
