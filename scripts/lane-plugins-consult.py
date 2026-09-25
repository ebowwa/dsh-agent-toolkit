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
compose pattern) and their overlay written under $DSH_HOME.
'profile-config'-seam entries mount NO package: they restate the config of a
plugin that ALREADY ships in the profile's module tree (patch rows replace
whole plugin config), gating on its presence there — a restated row naming a
missing package would be a dead mount. Every gate fails SAFE: platform
mismatch, node-glob mismatch, missing canonical copy, dead probe port, or
missing package => SKIP, and the run proceeds without that plugin. Nothing
here ever exits non-zero for a gated plugin.
"""
import glob
import json
import os
import shutil
import socket
import sys
import time

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


def profile_package_dir(home, name):
    """Where a profile-tree package must sit for `name` (e.g.
    '@deepseek-ai/dsh-session-query-sqlite')."""
    ns, leaf = (name.split("/", 1) + [name])[:2] if "/" in name else ("@local", name)
    return os.path.join(home, "profiles", "node_modules", ns, leaf)


def require_profile_packages_ok(home, entry):
    """Gate: every named package must ship in THIS job's profile module tree.
    A restated or tool row whose backend cannot resolve is a dead mount, and
    a dead mount must SKIP loud, never look mounted."""
    for name in entry.get("require_profile_packages") or []:
        d = profile_package_dir(home, name)
        if not package_complete(d):
            return name, d
    return None, None


def expand_config(c):
    """`~/...` strings expand against the invoking user's home — the box a
    dispatched job's DSH_HOME is job-scoped, so shared per-box paths in the
    manifest must ride the real home, not the job home."""
    return {k: (os.path.expanduser(v) if isinstance(v, str) else v) for k, v in c.items()}


def shared_index_db(entry, cfg):
    """Per-job db path under a SHARED per-box index directory. One shared
    index FILE would break the backend's single-process-owner contract: it
    reconciles under BEGIN IMMEDIATE with no busy timeout, and node:sqlite
    throws immediately on lock contention (measured), so the worker's
    parallel slots would flake every search. The index is the backend's own
    'dedicated disposable database' — the durable half of sharing is the
    persistence corpus, not this file. Any failure here SKIPs loud."""
    d = os.path.expanduser(entry["shared_index"])
    try:
        os.makedirs(d, mode=0o700, exist_ok=True)
        keep_s = float(os.environ.get("DSH_SESSION_INDEX_KEEP_DAYS", "14")) * 86400.0
        now = time.time()
        for f in glob.glob(os.path.join(d, "session-search-*.db*")):
            try:
                if now - os.path.getmtime(f) > keep_s:
                    os.unlink(f)
            except OSError:
                pass  # best-effort prune; a stuck file is never fatal
        cfg["path"] = os.path.join(d, f"session-search-{int(now * 1000)}-{os.getpid()}.db")
        return None
    except OSError as e:
        return str(e)


def write_patch(patch_file, manifest_name, node, pid, name, cfg, insert):
    with open(patch_file, "w") as f:
        f.write(f"# Stamped by lane-plugins-consult.py (manifest: {manifest_name}; node {node}).\n")
        if insert:
            # A bare row with an unknown id only warns and is silently
            # skipped — new plugins must ride the explicit insert grammar.
            f.write("# insert: because a bare row with an unknown id only warns and is silently skipped.\n")
            f.write("- insert:\n")
            f.write(f"    - id: {pid}\n")
            f.write(f"      name: '{name}'\n")
            if cfg:
                f.write("      config:\n")
                indent = "        "
        else:
            # A bare row REPLACES the whole config of an id that already
            # ships in the profile — every field it shipped must be restated.
            f.write("# Bare row: replaces the shipped row's whole config (restatement, not addition).\n")
            f.write(f"- id: {pid}\n")
            f.write(f"  name: '{name}'\n")
            if cfg:
                f.write("  config:\n")
                indent = "    "
        for k, v in (cfg or {}).items():
            f.write(f"{indent}{k}: {yaml_scalar(v)}\n")


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

        # seam == "profile-config": restate the config of a plugin that
        # ALREADY ships in the profile module tree — no package copy. This is
        # how shipped-off capabilities turn on (the session-query backend
        # ships as path ':memory:' / openAt 'never'): patch rows replace the
        # whole config, so the overlay restates every shipped field it cares
        # about. Config strings expand `~/`; `shared_index` swaps in a
        # per-job db path under a shared per-box directory (owner contract).
        if seam == "profile-config":
            if home is None:
                print(f"SKIP\t{pid}\tno --home given")
                continue
            pkg_name = entry.get("package", "")
            pkg_at = profile_package_dir(home, pkg_name) if pkg_name else ""
            if not pkg_name or not package_complete(pkg_at):
                print(f"SKIP\t{pid}\tprofile package '{pkg_name or '?'}' missing/incomplete at {pkg_at} (a restated row naming a missing package is a dead mount)")
                continue
            cfg = expand_config(entry.get("config") or {})
            if entry.get("shared_index"):
                err = shared_index_db(entry, cfg)
                if err:
                    print(f"SKIP\t{pid}\tshared index dir unusable ({err})")
                    continue
            patch_file = os.path.join(home, f"lane-plugin-{pid}.patch.yml")
            write_patch(patch_file, os.path.basename(manifest_path), node, pid, pkg_name, cfg, insert=False)
            print(f"PATCH\t{patch_file}")
            print(f"MOUNTED\t{pid}\tprofile-config seam ({pkg_name} restated; no copy)")
            continue

        # seam == "plugin": the compose pattern — per-job copy + overlay
        if home is None:
            print(f"SKIP\t{pid}\tno --home given")
            continue
        missing, missing_at = require_profile_packages_ok(home, entry)
        if missing:
            print(f"SKIP\t{pid}\tprofile package '{missing}' missing/incomplete at {missing_at} (the tools would register and fail every call)")
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
        try:
            if src_real != dst_real:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                if os.path.isdir(dest):
                    shutil.rmtree(dest)
                shutil.copytree(pkg_dir, dest)
        except OSError as e:
            # A crashed consult dies MID-LOOP: every later entry silently
            # never mounts (the wrapper used to swallow this traceback with
            # 2>/dev/null — a lane running with fewer plugins than its
            # manifest, zero signal). Degrade to a LOUD skip for THIS entry
            # and keep consulting the rest.
            print(f"SKIP\t{pid}\tcannot refresh plugin copy at {dest}: {e}")
            continue
        patch_file = os.path.join(home, f"lane-plugin-{pid}.patch.yml")
        write_patch(patch_file, os.path.basename(manifest_path), node, pid, name, entry.get("config") or {}, insert=True)
        print(f"PATCH\t{patch_file}")
        print(f"MOUNTED\t{pid}\tplugin seam ({name} -> {dest})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
