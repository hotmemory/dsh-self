@echo off
setlocal
set "NODE=%NODE_EXE%"
if not defined NODE (
  if exist "D:\DeepSeek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE=D:\DeepSeek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
)
if not defined NODE set "NODE=node"
"%NODE%" "%~dp0mem.mjs" %*
