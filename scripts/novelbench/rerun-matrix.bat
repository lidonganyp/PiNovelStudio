@echo off
REM R5: Full GLM/Doubao matrix rerun with correct env vars
REM Usage: scripts\novelbench\rerun-matrix.bat <model> <limit> <out-subdir>
REM Example: scripts\novelbench\rerun-matrix.bat glm 15 glm

setlocal
set PINOVEL_BENCHMARK_COST_PROFILE=package_screening
set PINOVEL_DISABLE_FALLBACK=1
set PINOVEL_MODEL_TOTAL_TIMEOUT_MS=1200000

set MODEL=%1
if "%MODEL%"=="" set MODEL=glm
set LIMIT=%2
if "%LIMIT%"=="" set LIMIT=15
set OUTSUB=%3
if "%OUTSUB%"=="" set OUTSUB=%MODEL%

node --env-file=.env scripts\novelbench\generation-matrix.mjs --model %MODEL% --limit %LIMIT% --timeout 180000 --out data\novelbench\generation-matrix-rerun\%OUTSUB%\
endlocal
