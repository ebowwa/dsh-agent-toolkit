#!/usr/bin/env python3
"""lane-plugins-consult.py — the runner's spawn-time consult of the plugin
delegation manifest (config/lane-plugins.json).

Called by run-dsh-agent.sh immediately before its native web seam:

    lane-plugins-consult.py --platform Darwin --node mini-native-open \
        --home "$DSH_HOME" [--root "$toolkit_root"] <manifest>

Emits line-based directives on stdout (tab-separated):

    ENV\\t<NAME>\\t<VALUE>      export this (primes the native seam)
    PATCH\\t<patch-file-path>   append one --patch for this overlay
    SKIP\\t<id>\\t<reason>      gated out — loud, never fatal

Plugin-seam entries additionally get their package copied per-job (the
compose pattern) and their overlay written under $DSH_HOME. Every gate
fails SAFE: platform mismatch, node-glob mismatch, missing canonical copy,
dead probe port, or missing package => SKIP, and the run proceeds without
that plugin. Nothing here ever exits non-zero for a gated plugin.
"""
import glob
import json
import os
import shutil
import socket
import sys

PLATFORM_MAP = {"Darwin": "macos", "Linux": "linux"}


def parse_args(argv):
    out = {"platform": None, "node": "", "home": None, "root": None, "manifest": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--platform":
            i += 1; out["platform"] = argv[i]
        elif a == "--node":
            i += 1; out["node"] = argv[i]
        elif a == "--home":
            i += 1; out["home"] = os.path.expanduser(argv[i])
        elif a == "--root":
            i += 1; out["root"] = os.path.expanduser(argv[i])
        else:
            out["manifest"] = a
        i += 1
    return out


def port_answers(port, host="127.0.0.1", timeout=1.0):
    try:
        s = socket.socket()
        s.settimeout(timeout)
        ok = s.connect_ex((host, port)) == 0
        s.close()
        return ok
    except Exception:
        return False


def yaml_scalar(v):
    return json.dumps(v)  # JSON scalars/arrays are valid YAML flow scalars


def plugin_package_name(pkg_dir):
    try:
        return json.load(open(os.path.join(pkg_dir, "package.json")))["name"]
    except Exception:
        return None


def package_complete(pkg_dir):
    return (
        os.path.isfile(os.path.join(pkg_dir, "package.json"))
        and os.path.isdir(os.path.join(pkg_dir, "lib"))
    )


def main():
    args = parse_args(sys.argv[1:])
    manifest_path = args["manifest"]
    if not manifest_path or not os.path.isfile(manifest_path):
        print(f"SKIP\tmanifest\tmissing manifest ({manifest_path})")
        return 0
    platform = PLATFORM_MAP.get(args["platform"] or "")
    if not platform:
        print(f"SKIP\tmanifest\tunknown platform {args['platform']!r}")
        return 0
    root = args["root"] or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    home = args["home"]
    manifest = json.load(open(manifest_path))
    node = args["node"] or ""

    import fnmatch  # node globs: fnmatch semantics, like the CI cell lists

    for entry in manifest.get(platform, []):
        pid = entry.get("id", "?")
        # node glob gate (default: every node of the platform)
        pats = entry.get("nodes") or ["*"]
        if not any(fnmatch.fnmatchcase(node, p) for p in pats):
            print(f"SKIP\t{pid}\tnode '{node}' not in nodes {pats}")
            continue
        seam = entry.get("seam", "plugin")

        if seam == "native-web":
            # canonical copy must exist (the keepalive sync materializes it);
            # a missing copy is a SKIP, never the runner's loud exit-2 death
            canon = os.path.expanduser(entry.get("canonical_dest", ""))
            if not canon or not package_complete(canon):
                print(f"SKIP\t{pid}\tcanonical copy missing/incomplete at {canon} (run sync-lane-plugins.sh from the keepalive)")
                continue
            browsers = []
            if entry.get("require_browser"):
                for pat in entry.get("browsers_probe", []):
                    for hit in sorted(glob.glob(os.path.expanduser(pat))):
                        if " " in hit:
                            continue  # the env pin rejects spaces; internal discovery covers those
                        if hit not in browsers:
                            browsers.append(hit)
                        if len(browsers) >= 2:
                            break
                    if len(browsers) >= 2:
                        break
                if not browsers:
                    print(f"SKIP\t{pid}\tno space-free probed browser (browsers_probe all miss)")
                    continue
            print(f"ENV\tDSH_WEB_SEARCH_CELLS\t{node}")
            if browsers:
                print("ENV\tDSH_WEB_SEARCH_BROWSER_BROWSERS\t" + " ".join(browsers))
            print(f"MOUNTED\t{pid}\tnative seam primed (canonical {canon})")
            continue

        # seam == "plugin": the compose pattern — per-job copy + overlay
        if home is None:
            print(f"SKIP\t{pid}\tno --home given")
            continue
        src = entry.get("source", {}).get("path", "")
        pkg_dir = os.path.join(root, src) if src else ""
        if entry.get("require_probe") and not port_answers(entry["probe_port"]):
            print(f"SKIP\t{pid}\t127.0.0.1:{entry['probe_port']} not answering (engine down here)")
            continue
        if not package_complete(pkg_dir):
            print(f"SKIP\t{pid}\tpackage missing/incomplete at {pkg_dir} (need package.json + lib/)")
            continue
        name = plugin_package_name(pkg_dir) or f"@local/{pid}"
        ns, leaf = (name.split("/", 1) + [name])[:2] if "/" in name else ("@local", name)
        dest = os.path.join(home, "profiles", "node_modules", ns, leaf)
        # same-tree guard (compose review r1 finding 1)
        src_real = os.path.realpath(pkg_dir)
        dst_real = os.path.realpath(dest) if os.path.isdir(dest) else dest
        if src_real != dst_real:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if os.path.isdir(dest):
                shutil.rmtree(dest)
            shutil.copytree(pkg_dir, dest)
        patch_file = os.path.join(home, f"lane-plugin-{pid}.patch.yml")
        with open(patch_file, "w") as f:
            f.write(f"# Stamped by lane-plugins-consult.py (manifest: {os.path.basename(manifest_path)}; node {node}).\n")
            f.write("# insert: because a bare row with an unknown id only warns and is silently skipped.\n")
            f.write("- insert:\n")
            f.write(f"    - id: {pid}\n")
            f.write(f"      name: '{name}'\n")
            cfg = entry.get("config") or {}
            if cfg:
                f.write("      config:\n")
                for k, v in cfg.items():
                    f.write(f"        {k}: {yaml_scalar(v)}\n")
        print(f"PATCH\t{patch_file}")
        print(f"MOUNTED\t{pid}\tplugin seam ({name} -> {dest})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
