@echo off
REM NB-4 Phase 1 screening wrapper — sets env vars then runs generation-matrix.mjs
REM Usage: scripts\novelbench\run-screening.bat <model> <limit> [--skip-existing]
REM Example: scripts\novelbench\run-screening.bat glm 15 --skip-existing
REM Output: data/novelbench/generation-matrix/<model>/

setlocal
set PINOVEL_BENCHMARK_COST_PROFILE=package_screening
set PINOVEL_DISABLE_FALLBACK=1
set PINOVEL_MODEL_TOTAL_TIMEOUT_MS=1200000

set MODEL=%1
if "%MODEL%"=="" set MODEL=glm
set LIMIT=%2
if "%LIMIT%"=="" set LIMIT=15
set SKIP=%3

node --env-file=.env scripts\novelbench\generation-matrix.mjs --model %MODEL% --limit %LIMIT% --timeout 180000 --out data\novelbench\generation-matrix\%MODEL%\ %SKIP%
endlocal
