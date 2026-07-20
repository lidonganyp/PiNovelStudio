@echo off
REM R5.4: Rebuild manifest + recompute pure B4 winrate (definitive + total-sample)
REM Usage: scripts/novelbench/rerun-report.bat
REM Runs both GLM and Doubao, outputs to console

setlocal

echo ============================================================
echo R5.4: Rebuilding manifest + GO/HOLD report
echo ============================================================

echo.
echo --- GLM: Rebuild manifest ---
node scripts\novelbench\rebuild-judge-manifest.mjs --judge-dir data\novelbench\judge-results-rerun\glm --matrix-dir data\novelbench\generation-matrix-rerun\glm

echo.
echo --- Doubao: Rebuild manifest ---
node scripts\novelbench\rebuild-judge-manifest.mjs --judge-dir data\novelbench\judge-results-rerun\doubao --matrix-dir data\novelbench\generation-matrix-rerun\doubao

echo.
echo ============================================================
echo Pure B4 Winrate (definitive + total-sample)
echo ============================================================

echo.
echo --- GLM pure B4 winrate ---
node scripts\novelbench\recompute-pure-b4-winrate.mjs --model glm --manifest data\novelbench\judge-results-rerun\glm\manifest.jsonl --matrix-dir data\novelbench\generation-matrix-rerun\glm

echo.
echo --- Doubao pure B4 winrate ---
node scripts\novelbench\recompute-pure-b4-winrate.mjs --model doubao --manifest data\novelbench\judge-results-rerun\doubao\manifest.jsonl --matrix-dir data\novelbench\generation-matrix-rerun\doubao

echo.
echo ============================================================
echo R5.4 Complete
echo ============================================================
endlocal
