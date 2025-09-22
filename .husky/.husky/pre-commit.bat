@echo off
npx lint-staged
if errorlevel 1 exit /b 1
