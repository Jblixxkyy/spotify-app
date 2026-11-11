@echo off
cd /d "%~dp0"

echo Downloading yt-dlp to tools\yt-dlp.exe ...
if not exist tools mkdir tools

rem Windows 10 (1803+) and Windows 11 ship curl.exe built in
curl -L -o tools\yt-dlp.exe https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
if errorlevel 1 (
    echo Download failed. You can also install yt-dlp manually:
    echo   winget install yt-dlp.yt-dlp
    echo   ^(or place yt-dlp.exe in the tools\ folder yourself^)
    pause
    exit /b 1
)

echo Done. Run start.bat to launch the server.
pause
