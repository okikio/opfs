"""Validate the planning handoff, not OPFS implementation or format support.

Run: python3 validate.py
Optionally compare original inputs: --input-dir CHECKPOINT_OUTPUT --original-plan OLD_PLAN
The input directory is the checkpoint's outputs/opfs-archive-encryption-review-20261105.
Only the Python standard library is used. This script reads files and prints JSON.
"""

import argparse
import csv
import hashlib
import json
from pathlib import Path
import re


def load(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def unique_ids(entries):
    values = [entry["id"] for entry in entries]
    assert len(values) == len(set(values)), "Duplicate IDs"
    return set(values)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--input-dir", type=Path)
parser.add_argument("--original-plan", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent
catalog = load(root / "catalog.json")
formats = load(root / "formats.json")
routes = load(root / "routing.json")
preview = load(root / "preview-routing.json")
crosswalk = load(root / "crosswalk.json")
implementations = load(root / "implementations.json")
catalog_ids = unique_ids(catalog["entries"])
format_ids = unique_ids(formats["entries"])
assert len(catalog_ids) == 895
assert len(format_ids) == 136
assert len(implementations) == 14
assert unique_ids(routes["entries"]) == catalog_ids
assert unique_ids([row["source_record"] for row in preview["entries"]]) == format_ids
assert preview["input_metadata"] == formats["metadata"]
assert preview["crosswalk"] == crosswalk
assert [row["source_record"] for row in preview["entries"]] == formats["entries"]
assert all(row["preview_plan"]["status"] == "proposed-not-implemented" for row in preview["entries"])
assert {row["focused_id"] for row in crosswalk["links"]} | set(crosswalk["unmapped_focused_ids"]) == format_ids
assert all(set(row["parent_ids"]) <= catalog_ids for row in crosswalk["links"])
parent_sha = "7fc1fefdfea648cfab176f38b6351b8b5c4d547b5a259ef103861aef8b6851b5"
assert digest(root / "catalog.json") == parent_sha
assert crosswalk["parent_sha256"] == parent_sha
with (root / "routing.csv").open(newline="") as stream:
    csv_rows = list(csv.DictReader(stream))
assert len(csv_rows) == 895
assert {row["id"] for row in csv_rows} == catalog_ids

links_checked = 0
for path in root.glob("*.md"):
    for destination in re.findall(r"\]\(([^)]+)\)", path.read_text()):
        if re.match(r"https?://|mailto:|#", destination):
            continue
        target = destination.split("#")[0]
        assert not Path(target).is_absolute(), f"Nonportable link: {path.name}: {target}"
        assert (root / target).is_file(), f"Broken link: {path.name}: {target}"
        links_checked += 1

original_checks = []
if args.input_dir:
    pairs = {
        "formats.json": "formats-and-profiles.json",
        "implementations.json": "implementation-matrix.json",
        "crosswalk.json": "catalog-crosswalk.json",
        "archive-research.md": "archive-encryption-review.md",
    }
    for retained, original in pairs.items():
        assert (root / retained).read_bytes() == (args.input_dir / original).read_bytes(), retained
        original_checks.append(retained)
if args.original_plan:
    for filename in ["catalog.json", "routing.json", "routing.csv", "catalog-research.md", "protocol-research.md"]:
        assert (root / filename).read_bytes() == (args.original_plan / filename).read_bytes(), filename
        original_checks.append(filename)

files = {
    path.name: digest(path)
    for path in sorted(root.iterdir())
    if path.is_file() and path.name != "validation.json" and path.suffix != ".zip"
}
print(json.dumps({
    "scope": "Planning artifact only; no implementation, interoperability, CI, security or benchmark certification",
    "passed": True,
    "catalog_records": 895,
    "focused_records": 136,
    "implementation_comparisons": 14,
    "parent_catalog_sha256": parent_sha,
    "source_records_and_crosswalk_preserved": True,
    "all_routes_proposed_not_implemented": True,
    "local_markdown_links_checked": links_checked,
    "original_files_compared": original_checks,
    "file_sha256": files,
}, indent=2))
