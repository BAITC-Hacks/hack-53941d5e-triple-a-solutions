#!/usr/bin/env python3
"""Prepare local-only prototype data without changing the organizer's files."""

import argparse
import csv
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path, help="career_quest_dataset directory")
    args = parser.parse_args()
    source = args.source.expanduser().resolve()
    documents = {name: json.loads((source / f"{name}.json").read_text(encoding="utf-8-sig"))
                 for name in ("employees", "events", "skills")}
    dates = {doc["meta"]["as_of_date"] for doc in documents.values()}
    if len(dates) != 1:
        raise ValueError("Dataset snapshot dates must match")
    with (source / "activity_history.csv").open(encoding="utf-8-sig", newline="") as stream:
        history = list(csv.DictReader(stream))
    result = {
        "asOf": dates.pop(),
        "employees": documents["employees"]["employees"],
        "events": documents["events"]["events"],
        "skills": documents["skills"]["skills"],
        "roleProfiles": documents["skills"]["role_profiles"],
        "history": history,
    }
    output = Path(__file__).resolve().parents[1] / "src/prototype/data.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    print(f"Prepared {len(result['employees'])} profiles and {len(result['events'])} events: {output}")


if __name__ == "__main__":
    main()
