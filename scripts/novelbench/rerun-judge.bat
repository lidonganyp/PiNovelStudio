@echo off
REM R5.3: Reference-aware Judge rerun for GLM/Doubao B0 vs B4
REM Usage: scripts/novelbench/rerun-judge.bat <model>
REM Example: scripts/novelbench/rerun-judge.bat glm
REM          scripts\novelbench\rerun-judge.bat doubao

setlocal
set PINOVEL_BENCHMARK_COST_PROFILE=package_screening
set PINOVEL_DISABLE_FALLBACK=1
set PINOVEL_MODEL_TOTAL_TIMEOUT_MS=1200000

set MODEL=%1
if "%MODEL%"=="" set MODEL=glm

node --env-file=.env scripts\novelbench\reference-aware-judge.mjs --matrix-dir data\novelbench\generation-matrix-rerun\%MODEL% --model %MODEL% --pairs "B0,B4" --rounds 3 --out data\novelbench\judge-results-rerun\%MODEL%
endlocal
