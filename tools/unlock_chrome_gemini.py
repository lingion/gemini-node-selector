#!/usr/bin/env python3
"""
Unlock Chrome built-in Gemini (Glic) eligibility across Chrome 158+ profiles.

Patches Chrome `Local State` and per-profile `Preferences` cleanly with
pre-patch backups, refuses to overwrite while Chrome is running unless
explicitly instructed, and supports rollback via `--restore`.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


CHROME_ARGS = [
    "--variations-override-country=us",
    "--enable-features=GlicRollout",
]


def default_user_data_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Google/Chrome"
    if sys.platform.startswith("win"):
        local_app = os.environ.get("LOCALAPPDATA", "")
        if not local_app:
            raise RuntimeError("LOCALAPPDATA is not set")
        return Path(local_app) / "Google/Chrome/User Data"
    return Path.home() / ".config/google-chrome"


def is_default_user_data_dir(user_data_dir: Path) -> bool:
    try:
        return user_data_dir.expanduser().resolve() == default_user_data_dir().expanduser().resolve()
    except OSError:
        return False


def is_chrome_running() -> bool:
    if sys.platform == "darwin":
        res = subprocess.run(
            ["pgrep", "-x", "Google Chrome"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return res.returncode == 0
    if sys.platform.startswith("linux"):
        res = subprocess.run(
            ["pgrep", "-f", "chrome"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return res.returncode == 0
    return False


def quit_chrome_gracefully(timeout_seconds: float = 8.0) -> bool:
    if not is_chrome_running():
        return True
    if sys.platform == "darwin":
        subprocess.run(
            ["osascript", "-e", 'tell application "Google Chrome" to quit'],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        return False

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not is_chrome_running():
            return True
        time.sleep(0.25)
    return not is_chrome_running()


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return data


def save_json_atomic(path: Path, data: dict[str, Any]) -> None:
    tmp_path = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    with tmp_path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_path, path)


def backup_once(path: Path) -> Path:
    bak_path = path.with_name(f"{path.name}.gns.bak")
    if not bak_path.exists():
        shutil.copy2(path, bak_path)
    return bak_path


def find_profile_dirs(user_data_dir: Path, local_state: dict[str, Any] | None) -> list[Path]:
    candidates: dict[str, Path] = {}
    default_dir = user_data_dir / "Default"
    if (default_dir / "Preferences").is_file():
        candidates[str(default_dir)] = default_dir

    for entry in sorted(user_data_dir.iterdir()):
        if entry.is_dir() and entry.name.startswith("Profile ") and (entry / "Preferences").is_file():
            candidates[str(entry)] = entry

    if isinstance(local_state, dict):
        profile_section = local_state.get("profile")
        if isinstance(profile_section, dict):
            info_cache = profile_section.get("info_cache")
            if isinstance(info_cache, dict):
                for profile_key in sorted(info_cache.keys()):
                    pdir = user_data_dir / profile_key
                    if (pdir / "Preferences").is_file():
                        candidates[str(pdir)] = pdir

    return list(candidates.values())


def patch_local_state_dict(data: dict[str, Any]) -> list[str]:
    changes: list[str] = []

    if "is_glic_eligible" in data and data.get("is_glic_eligible") is not True:
        data["is_glic_eligible"] = True
        changes.append("Local State: is_glic_eligible = true")

    if data.get("variations_country") != "us":
        data["variations_country"] = "us"
        changes.append("Local State: variations_country = 'us'")

    perm = data.get("variations_permanent_consistency_country")
    if isinstance(perm, list) and len(perm) >= 2:
        target_perm = [perm[0], "us", *perm[2:]]
    else:
        target_perm = ["us"]
    if perm != target_perm:
        data["variations_permanent_consistency_country"] = target_perm
        changes.append(f"Local State: variations_permanent_consistency_country = {target_perm}")

    if data.get("variations_safe_seed_session_consistency_country") != "us":
        data["variations_safe_seed_session_consistency_country"] = "us"
        changes.append("Local State: variations_safe_seed_session_consistency_country = 'us'")

    glic = data.get("glic")
    if not isinstance(glic, dict):
        glic = {}
        data["glic"] = glic
    if glic.get("launcher_enabled") is not True:
        glic["launcher_enabled"] = True
        changes.append("Local State: glic.launcher_enabled = true")
    if glic.get("multi_instance_enabled_by_tier") is not True:
        glic["multi_instance_enabled_by_tier"] = True
        changes.append("Local State: glic.multi_instance_enabled_by_tier = true")

    profile = data.get("profile")
    if isinstance(profile, dict):
        info_cache = profile.get("info_cache")
        if isinstance(info_cache, dict):
            for profile_name, info in sorted(info_cache.items()):
                if isinstance(info, dict) and info.get("is_glic_eligible") is not True:
                    info["is_glic_eligible"] = True
                    changes.append(f"Local State: profile.info_cache[{profile_name!r}].is_glic_eligible = true")

    return changes


def patch_preferences_dict(prefs: dict[str, Any], profile_name: str) -> list[str]:
    changes: list[str] = []

    glic = prefs.get("glic")
    if not isinstance(glic, dict):
        glic = {}
        prefs["glic"] = glic

    if glic.get("completed_fre") != 1:
        glic["completed_fre"] = 1
        changes.append(f"{profile_name}/Preferences: glic.completed_fre = 1")

    if glic.get("previously_not_allowed") is not False:
        glic["previously_not_allowed"] = False
        changes.append(f"{profile_name}/Preferences: glic.previously_not_allowed = false")

    iph = prefs.get("in_product_help")
    if isinstance(iph, dict):
        snoozed = iph.get("snoozed_feature")
        if isinstance(snoozed, dict):
            try_it = snoozed.get("IPH_GlicTryIt")
            if isinstance(try_it, dict) and try_it.get("is_dismissed") is not False:
                try_it["is_dismissed"] = False
                changes.append(
                    f"{profile_name}/Preferences: in_product_help.snoozed_feature.IPH_GlicTryIt.is_dismissed = false"
                )

    return changes


def ensure_safe_to_write(user_data_dir: Path, force: bool, kill_chrome: bool) -> int:
    if not is_default_user_data_dir(user_data_dir):
        return 0
    if not is_chrome_running():
        return 0
    if kill_chrome:
        print("Google Chrome is running; sending graceful quit request...")
        if not quit_chrome_gracefully():
            print(
                "Error: Google Chrome did not exit within timeout. Close Chrome manually and retry.",
                file=sys.stderr,
            )
            return 2
        return 0
    if force:
        print(
            "Warning: Google Chrome is running and --force was passed; Chrome may overwrite edits on exit.",
            file=sys.stderr,
        )
        return 0
    print(
        "Refusing to patch while Google Chrome is running because Chrome overwrites Local State on exit.\n"
        "Quit Chrome (Cmd+Q) and re-run, or pass --kill-chrome if you explicitly approve quitting and relaunching.",
        file=sys.stderr,
    )
    return 2


def print_status(user_data_dir: Path) -> int:
    local_state_path = user_data_dir / "Local State"
    if not local_state_path.is_file():
        print(f"Missing Local State at {local_state_path}", file=sys.stderr)
        return 1
    local_state = load_json(local_state_path)
    summary: dict[str, Any] = {
        "chrome_running": is_chrome_running() if is_default_user_data_dir(user_data_dir) else None,
        "user_data_dir": str(user_data_dir),
        "variations_country": local_state.get("variations_country"),
        "variations_permanent_consistency_country": local_state.get("variations_permanent_consistency_country"),
        "variations_safe_seed_session_consistency_country": local_state.get(
            "variations_safe_seed_session_consistency_country"
        ),
        "glic": local_state.get("glic"),
        "profile_info_cache": {},
        "profiles": {},
    }
    info_cache = local_state.get("profile", {}).get("info_cache", {})
    if isinstance(info_cache, dict):
        summary["profile_info_cache"] = {
            name: info.get("is_glic_eligible")
            for name, info in sorted(info_cache.items())
            if isinstance(info, dict)
        }
    for pdir in find_profile_dirs(user_data_dir, local_state):
        prefs = load_json(pdir / "Preferences")
        iph_try_it = (
            prefs.get("in_product_help", {})
            .get("snoozed_feature", {})
            .get("IPH_GlicTryIt")
        )
        summary["profiles"][pdir.name] = {
            "glic": prefs.get("glic"),
            "IPH_GlicTryIt": iph_try_it,
        }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def patch(user_data_dir: Path, force: bool, kill_chrome: bool) -> int:
    local_state_path = user_data_dir / "Local State"
    if not local_state_path.is_file():
        print(f"Chrome Local State not found at {local_state_path}", file=sys.stderr)
        return 1

    guard_rc = ensure_safe_to_write(user_data_dir, force=force, kill_chrome=kill_chrome)
    if guard_rc != 0:
        return guard_rc

    local_state = load_json(local_state_path)
    ls_backup = backup_once(local_state_path)
    ls_changes = patch_local_state_dict(local_state)
    if ls_changes:
        save_json_atomic(local_state_path, local_state)
        print(f"Backup: {ls_backup}")
        for line in ls_changes:
            print(f"  + {line}")
    else:
        print(f"Local State already patched (backup: {ls_backup}).")

    profile_dirs = find_profile_dirs(user_data_dir, local_state)
    for pdir in profile_dirs:
        pref_path = pdir / "Preferences"
        prefs = load_json(pref_path)
        pref_backup = backup_once(pref_path)
        pref_changes = patch_preferences_dict(prefs, pdir.name)
        if pref_changes:
            save_json_atomic(pref_path, prefs)
            print(f"Backup: {pref_backup}")
            for line in pref_changes:
                print(f"  + {line}")
        else:
            print(f"{pdir.name}/Preferences already patched (backup: {pref_backup}).")

    return 0


def restore(user_data_dir: Path, force: bool, kill_chrome: bool) -> int:
    guard_rc = ensure_safe_to_write(user_data_dir, force=force, kill_chrome=kill_chrome)
    if guard_rc != 0:
        return guard_rc

    restored_any = False
    local_state_path = user_data_dir / "Local State"
    for candidate_name in ("Local State.gns.bak", "Local State.bak"):
        bak = user_data_dir / candidate_name
        if bak.is_file():
            shutil.copy2(bak, local_state_path)
            print(f"Restored {local_state_path} from {bak}")
            restored_any = True
            break

    local_state = load_json(local_state_path) if local_state_path.is_file() else None
    for pdir in find_profile_dirs(user_data_dir, local_state):
        pref_path = pdir / "Preferences"
        bak = pdir / "Preferences.gns.bak"
        if bak.is_file():
            shutil.copy2(bak, pref_path)
            print(f"Restored {pref_path} from {bak}")
            restored_any = True

    if not restored_any:
        print("No .gns.bak backup files found.", file=sys.stderr)
        return 1
    return 0


def launch_chrome() -> int:
    if sys.platform != "darwin":
        print("Warning: --launch currently implements macOS 'open -a \"Google Chrome\"' only.", file=sys.stderr)
        return 1
    cmd = ["open", "-a", "Google Chrome", "--args", *CHROME_ARGS]
    res = subprocess.run(cmd, check=False)
    if res.returncode == 0:
        print(f"Launched Google Chrome with args: {' '.join(CHROME_ARGS)}")
    return res.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Unlock Chrome built-in Gemini (Glic) for Chrome 158+.")
    parser.add_argument("--restore", action="store_true", help="Restore Local State and Preferences from .gns.bak")
    parser.add_argument("--status", action="store_true", help="Print current Glic/variations status without writing")
    parser.add_argument("--force", action="store_true", help="Patch even while Google Chrome is running")
    parser.add_argument("--kill-chrome", action="store_true", help="Gracefully quit Google Chrome before patching")
    parser.add_argument("--launch", action="store_true", help="Launch Google Chrome with Glic feature flags after patch")
    parser.add_argument(
        "--user-data-dir",
        type=Path,
        default=None,
        help="Override Chrome User Data directory (for testing against a staging copy)",
    )
    args = parser.parse_args()

    user_data_dir = (args.user_data_dir or default_user_data_dir()).expanduser()

    if args.status:
        return print_status(user_data_dir)
    if args.restore:
        rc = restore(user_data_dir, force=args.force, kill_chrome=args.kill_chrome)
    else:
        rc = patch(user_data_dir, force=args.force, kill_chrome=args.kill_chrome)
        if rc == 0 and args.launch:
            rc = launch_chrome()
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
