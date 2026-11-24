@echo off
rem ateam command (installed to %LOCALAPPDATA%\Programs\ateam, which the installer adds to the user PATH).
rem Runs the bundled node. Dev mode (%USERPROFILE%\.config\ateam\dev-repo) runs the source repo instead of app\.
rem Keep this file ASCII only: cmd reads batch files in the OEM code page. See build.sh.
setlocal
set "ATEAM_APP=%~dp0app\bin\ateam.js"
set "ATEAM_REPO="
if exist "%USERPROFILE%\.config\ateam\dev-repo" set /p ATEAM_REPO=<"%USERPROFILE%\.config\ateam\dev-repo"
if defined ATEAM_REPO if exist "%ATEAM_REPO%\bin\ateam.js" set "ATEAM_APP=%ATEAM_REPO%\bin\ateam.js"
"%~dp0node\@NODE_VERSION@\node.exe" "%ATEAM_APP%" %*
exit /b %ERRORLEVEL%
