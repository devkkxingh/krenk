"""
Krenk TBench Benchmark Agent
=============================

Integrates Krenk (multi-agent CLI) with Harbor/Terminal-Bench for benchmarking.

Usage:
  1. pip install harbor
  2. export ANTHROPIC_API_KEY="your-key"
  3. harbor run -d "terminal-bench@2.0" --agent-import-path "benchmark.krenk_tbench:KrenkAgent"

For cloud execution (Daytona):
  export DAYTONA_API_KEY="your-key"
  harbor run -d "terminal-bench@2.0" --agent-import-path "benchmark.krenk_tbench:KrenkAgent" --env daytona -n 8
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


# Krenk version — update when bumping
KRENK_VERSION = "0.1.7"

# Timeout per task (seconds)
TASK_TIMEOUT = 900  # 15 minutes

# Node.js version to install
NODE_VERSION = "20"


class KrenkAgent(BaseAgent):
    """
    Harbor-compatible agent that runs Krenk CLI for TBench tasks.

    Uses the External Agent pattern (BaseAgent) so we can control
    installation and execution step-by-step via environment.exec().
    """

    SUPPORTS_ATIF: bool = False

    @staticmethod
    def name() -> str:
        return "krenk"

    def version(self) -> str | None:
        return KRENK_VERSION

    async def setup(self, environment: BaseEnvironment) -> None:
        """Install Node.js and Krenk inside the container."""
        self.logger.info("Installing Node.js and Krenk...")

        # Install Node.js
        result = await environment.exec(
            command=(
                "apt-get update -qq && "
                "apt-get install -y -qq curl > /dev/null 2>&1 && "
                f"curl -fsSL https://deb.nodesource.com/setup_{NODE_VERSION}.x | bash - > /dev/null 2>&1 && "
                "apt-get install -y -qq nodejs > /dev/null 2>&1 && "
                "node --version && npm --version"
            ),
            timeout_sec=120,
        )
        self.logger.info(f"Node.js install: exit={result.return_code}, out={result.stdout}")

        if result.return_code != 0:
            self.logger.error(f"Node.js install failed: {result.stderr}")
            raise RuntimeError(f"Node.js installation failed: {result.stderr}")

        # Install Claude Code CLI (required by krenk)
        result = await environment.exec(
            command="npm install -g @anthropic-ai/claude-code > /dev/null 2>&1 && claude --version",
            timeout_sec=120,
            env={"CLAUDECODE": ""},  # unset to avoid nested session error
        )
        self.logger.info(f"Claude Code install: exit={result.return_code}, out={result.stdout}")

        # Install Krenk globally
        result = await environment.exec(
            command="npm install -g krenk > /dev/null 2>&1 && krenk --version",
            timeout_sec=60,
        )
        self.logger.info(f"Krenk install: exit={result.return_code}, out={result.stdout}")

        if result.return_code != 0:
            self.logger.error(f"Krenk install failed: {result.stderr}")
            raise RuntimeError(f"Krenk installation failed: {result.stderr}")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """
        Run Krenk against a TBench task.

        TBench tasks are terminal-focused (shell commands, system admin, etc.)
        so we run Krenk in Quick Build mode (strategist + builder only)
        with no UI for headless execution.
        """
        self.logger.info(f"Running Krenk on task: {instruction[:100]}...")

        # Escape the instruction for shell
        escaped = instruction.replace("'", "'\\''")

        # Run krenk in non-interactive mode with minimal agents
        # Quick Build: strategist (plan) + builder (execute) only
        result = await environment.exec(
            command=(
                f"krenk run '{escaped}' "
                "--no-ui "
                "--skip analyzing designing qa-planning testing reviewing securing documenting deploying"
            ),
            cwd="/home/user",
            timeout_sec=TASK_TIMEOUT,
            env={
                "ANTHROPIC_API_KEY": self._get_api_key(),
                # Prevent nested session detection
                "CLAUDECODE": "",
                "CLAUDE_CODE_ENTRYPOINT": "",
            },
        )

        self.logger.info(f"Krenk finished: exit={result.return_code}, duration output length={len(result.stdout or '')}")

        # Log full output for debugging
        log_file = self.logs_dir / "krenk_output.txt"
        log_file.write_text(
            f"=== STDOUT ===\n{result.stdout or ''}\n\n"
            f"=== STDERR ===\n{result.stderr or ''}\n\n"
            f"=== EXIT CODE ===\n{result.return_code}\n"
        )

        # Parse output and populate context
        self._populate_context(result.stdout or "", result.stderr or "", context)

    def _get_api_key(self) -> str:
        """Get Anthropic API key from environment."""
        import os
        key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not key:
            self.logger.warning("ANTHROPIC_API_KEY not set")
        return key

    def _populate_context(
        self,
        stdout: str,
        stderr: str,
        context: AgentContext,
    ) -> None:
        """
        Parse Krenk output to extract metrics.
        Krenk saves state.json with run info — try to parse it.
        """
        metadata: dict[str, Any] = {}

        # Try to extract stage count and duration from output
        # Krenk prints: "[done] Completed X stages in Ym Zs"
        done_match = re.search(r"Completed (\d+) stages? in (.+)", stdout)
        if done_match:
            metadata["stages_completed"] = int(done_match.group(1))
            metadata["duration_str"] = done_match.group(2)

        # Check for failure
        fail_match = re.search(r"\[fail\] Workflow failed after (\d+) stages?", stdout)
        if fail_match:
            metadata["stages_completed"] = int(fail_match.group(1))
            metadata["success"] = False
        elif done_match:
            metadata["success"] = True
        else:
            metadata["success"] = False
            metadata["note"] = "Could not parse krenk output"

        # Try to read state.json if krenk wrote one
        try:
            state_lines = stdout.split("\n")
            for line in state_lines:
                if '"stageCount"' in line or '"completedStages"' in line:
                    # Found JSON-like content in output
                    pass
        except Exception:
            pass

        # Store raw output length as a rough metric
        metadata["output_length"] = len(stdout)
        metadata["stderr_length"] = len(stderr)

        context.metadata = metadata


class KrenkInstalledAgent:
    """
    Alternative: Installed Agent pattern.
    Use this if you prefer Harbor to manage installation via a Jinja2 template.

    Usage:
      harbor run -d "terminal-bench@2.0" --agent-import-path "benchmark.krenk_tbench:KrenkInstalledAgent"

    Requires install-krenk.sh.j2 template in the same directory.
    """

    # This is provided as reference — use KrenkAgent (above) for simplicity.
    pass


# ── Standalone test runner ────────────────────────────────────
# Run this file directly to test Krenk against sample tasks
# without Harbor, useful for quick local validation.

SAMPLE_TASKS = [
    {
        "id": "sample-1",
        "instruction": "Create a Python script that reads a CSV file and outputs the top 5 rows sorted by the second column in descending order. The script should handle missing values gracefully.",
        "category": "coding",
    },
    {
        "id": "sample-2",
        "instruction": "Write a bash script that monitors disk usage and sends a warning to stdout if any partition exceeds 80% usage. Include the partition name, used space, and percentage.",
        "category": "sysadmin",
    },
    {
        "id": "sample-3",
        "instruction": "Create a Node.js HTTP server that responds to GET /health with a JSON object containing uptime, memory usage, and current timestamp. Use only built-in modules.",
        "category": "coding",
    },
    {
        "id": "sample-4",
        "instruction": "Write a Python script that takes a directory path as argument and generates a markdown file listing all files recursively with their sizes, organized by file extension.",
        "category": "coding",
    },
    {
        "id": "sample-5",
        "instruction": "Create a shell script that sets up a basic git repository with a .gitignore for Node.js projects, an initial commit, and creates develop and staging branches.",
        "category": "sysadmin",
    },
]


async def run_standalone_benchmark(tasks: list[dict] | None = None):
    """
    Run Krenk benchmark locally without Harbor.
    Spawns krenk directly and measures success.
    """
    import asyncio
    import os
    import subprocess
    import time

    tasks = tasks or SAMPLE_TASKS
    results = []

    print(f"\n{'='*60}")
    print(f"  Krenk Standalone Benchmark")
    print(f"  Tasks: {len(tasks)}")
    print(f"{'='*60}\n")

    for i, task in enumerate(tasks):
        task_id = task["id"]
        instruction = task["instruction"]
        category = task.get("category", "unknown")

        print(f"[{i+1}/{len(tasks)}] {task_id} ({category})")
        print(f"  Task: {instruction[:80]}...")

        # Create isolated working directory
        work_dir = Path(f"/tmp/krenk-bench/{task_id}")
        work_dir.mkdir(parents=True, exist_ok=True)

        start = time.time()
        try:
            env = {**os.environ}
            env.pop("CLAUDECODE", None)
            env.pop("CLAUDE_CODE_ENTRYPOINT", None)

            proc = subprocess.run(
                [
                    "krenk", "run", instruction,
                    "--no-ui",
                    "--skip", "analyzing", "designing", "qa-planning",
                    "testing", "reviewing", "securing", "documenting", "deploying",
                ],
                cwd=str(work_dir),
                env=env,
                capture_output=True,
                text=True,
                timeout=TASK_TIMEOUT,
            )

            duration = round(time.time() - start, 1)
            success = proc.returncode == 0

            # Check if any files were actually created
            created_files = list(work_dir.rglob("*"))
            # Exclude .krenk internal files
            user_files = [
                f for f in created_files
                if f.is_file() and ".krenk" not in str(f)
            ]

            result = {
                "task_id": task_id,
                "category": category,
                "success": success,
                "exit_code": proc.returncode,
                "duration_sec": duration,
                "files_created": len(user_files),
                "stdout_len": len(proc.stdout),
                "stderr_len": len(proc.stderr),
            }

            status = "PASS" if success else "FAIL"
            print(f"  Result: {status} | {duration}s | {len(user_files)} files created")

        except subprocess.TimeoutExpired:
            duration = round(time.time() - start, 1)
            result = {
                "task_id": task_id,
                "category": category,
                "success": False,
                "exit_code": -1,
                "duration_sec": duration,
                "files_created": 0,
                "stdout_len": 0,
                "stderr_len": 0,
                "error": "timeout",
            }
            print(f"  Result: TIMEOUT after {duration}s")

        except Exception as e:
            duration = round(time.time() - start, 1)
            result = {
                "task_id": task_id,
                "category": category,
                "success": False,
                "exit_code": -1,
                "duration_sec": duration,
                "files_created": 0,
                "stdout_len": 0,
                "stderr_len": 0,
                "error": str(e),
            }
            print(f"  Result: ERROR - {e}")

        results.append(result)
        print()

    # Print summary
    passed = sum(1 for r in results if r["success"])
    total = len(results)
    total_duration = sum(r["duration_sec"] for r in results)
    total_files = sum(r["files_created"] for r in results)

    print(f"{'='*60}")
    print(f"  RESULTS: {passed}/{total} passed ({100*passed/total:.0f}%)")
    print(f"  Total time: {total_duration:.0f}s")
    print(f"  Total files created: {total_files}")
    print(f"{'='*60}")

    # Per-category breakdown
    categories: dict[str, list] = {}
    for r in results:
        cat = r["category"]
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(r)

    print(f"\n  By category:")
    for cat, cat_results in sorted(categories.items()):
        cat_passed = sum(1 for r in cat_results if r["success"])
        print(f"    {cat}: {cat_passed}/{len(cat_results)}")

    # Save results to JSON
    results_file = Path("/tmp/krenk-bench/results.json")
    results_file.write_text(json.dumps(results, indent=2))
    print(f"\n  Results saved to: {results_file}")

    return results


if __name__ == "__main__":
    import asyncio
    asyncio.run(run_standalone_benchmark())
