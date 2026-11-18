"""Command line: validate a scene, or print its sampled camera frames as JSON."""
import argparse
import json
import sys

from .scene import load_scene, sample_cameras, validate_scene


def main(argv):
    parser = argparse.ArgumentParser(prog="zaude_engine", description="Validate scene files and sample camera paths.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="check a scene file and list every problem found")
    v.add_argument("scene")
    c = sub.add_parser("cameras", help="print per-frame camera poses as JSON")
    c.add_argument("scene")
    args = parser.parse_args(argv)

    scene = load_scene(args.scene)
    errors = validate_scene(scene)
    if errors:
        print(f"{args.scene}: {len(errors)} problem(s)", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    if args.cmd == "validate":
        print(f"{args.scene}: valid")
        return 0
    json.dump(sample_cameras(scene), sys.stdout, indent=2)
    print()
    return 0
