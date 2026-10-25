@echo off
cd /d "%~dp0"
if exist "%~dp0runtime.local.cmd" call "%~dp0runtime.local.cmd"
if not defined NODE_EXE set "NODE_EXE=node"
if not exist "logs" mkdir "logs"
if not exist "logs" exit /b 1
"%NODE_EXE%" batch-learn.mjs >> "logs\batch-task.log" 2>&1
