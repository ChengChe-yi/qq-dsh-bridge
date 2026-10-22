@echo off
chcp 65001 >nul
rem ^ 第一件事就切到 UTF-8。本文件按「UTF-8 无 BOM + CRLF」保存，
rem   少了这一行，下面的中文在 GBK 控制台上会变成乱码。

setlocal EnableExtensions DisableDelayedExpansion
title QQ-DSH Bridge

rem ======================================================================
rem  QQ-DSH Bridge —— 示例启动脚本（Windows）
rem
rem  用法
rem    1. 复制本文件为 Launch.bat，放在仓库根目录（与 package.json 同级）
rem    2. 复制 config.example.json 为 config.json，填上自己的 QQ 号等信息
rem    3. 双击运行；下面的「可改的地方」看一遍就够了，其余不用动
rem
rem  参数（原样透传给 src/main.js）
rem    Launch.bat                      正常启动
rem    Launch.bat --check              只校验 config.json，不连网
rem    Launch.bat --loglevel=debug     临时覆盖任一配置项（--键=值）
rem
rem  环境变量
rem    QQ_NODE=<node.exe 完整路径>       手动指定 node（不设则自动查找）
rem    QQ_NO_PAUSE=1                     退出后不停留（计划任务 / CI 里用）
rem    QQBRIDGE_*                        覆盖配置项，见 src/config/load.js
rem ======================================================================

rem 工作目录必须是仓库根：双击运行时 %CD% 是 C:\Windows\system32，
rem 相对路径（src\main.js、config.json、workspaces\）全都会找不到。
cd /d "%~dp0"

echo.
echo   QQ-DSH Bridge
echo   ==============
echo.

rem ── 可改的地方 ───────────────────────────────────────────────────────
rem 端口、QQ 号、允许的群 / 私聊、日志级别这些**都不在这个脚本里改**，
rem 在 config.json 里改（保存后自动热重载，只有 host / port 要重启）。
rem 这个脚本只负责三件事：找到 node、确认目录对、把它拉起来。

rem ── 找 node ─────────────────────────────────────────────────────────
rem 顺序：QQ_NODE 指定值 → PATH → 几个常见安装位置。
rem 只信 PATH 是不够的：装完 Node 之后新开的窗口才看得到新 PATH，
rem 而「改完 PATH 直接双击旧脚本」正是最常见的踩坑方式。
set "NODE_BIN="
if defined QQ_NODE if exist "%QQ_NODE%" set "NODE_BIN=%QQ_NODE%"
if not defined NODE_BIN for %%P in (node.exe) do set "NODE_BIN=%%~$PATH:P"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if exist "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" set "NODE_BIN=%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Volta\bin\node.exe"
if defined NVM_SYMLINK if not defined NODE_BIN if exist "%NVM_SYMLINK%\node.exe" set "NODE_BIN=%NVM_SYMLINK%\node.exe"

if not defined NODE_BIN (
    echo   [ERROR] 没找到 node.exe
    echo.
    echo   装一个 Node.js 22 LTS 或更新版本： https://nodejs.org/
    echo   装在非默认位置的话，设环境变量 QQ_NODE 指向 node.exe 的完整路径。
    goto :fail
)

rem 版本号从 `node -v`（v24.22.1）里拆，纯批处理就够了。
rem 别把 JS 塞进 for /f 的命令行：那里同时有引号、括号和单引号，
rem cmd 的解析规则会咬人 —— 路径带空格时命令会被从空格处截断（踩过）。
set "NODE_VER="
set "NODE_MAJOR="
for /f "delims=" %%v in ('"%NODE_BIN%" -v') do set "NODE_VER=%%v"
for /f "tokens=1 delims=v." %%a in ("%NODE_VER%") do set "NODE_MAJOR=%%a"

if not defined NODE_VER (
    echo   [ERROR] 找到了 "%NODE_BIN%"，但它跑不起来
    echo   在命令行里手动执行 "%NODE_BIN%" -v 看看报什么错。
    goto :fail
)

rem 这里只卡主版本。engines 写的是 22.13.0，低于它不一定坏，
rem 但也别指望被支持 —— 只挡住明显太旧的那批，不拦同级的小版本差。
if %NODE_MAJOR% LSS 22 (
    echo   [ERROR] Node.js 版本太旧：%NODE_VER%
    echo   需要 22 或更新，package.json 的 engines 是 22.13.0。
    goto :fail
)

rem 把 node 所在目录插到 PATH 最前面：桥接拉起的子进程（MCP server 等）
rem 也会用它，版本才和父进程一致。
for %%D in ("%NODE_BIN%") do set "PATH=%%~dpD;%PATH%"

rem ── 确认是仓库根 ─────────────────────────────────────────────────────
if not exist "src\main.js" (
    echo   [ERROR] 这里不是仓库根目录：找不到 src\main.js
    echo   当前目录：%CD%
    echo   把这个脚本放到与 package.json 同一层再运行。
    goto :fail
)

if not exist "config.json" (
    echo   [WARN] 没有 config.json，将用内置默认值启动
    echo          第一次用请先复制模板：copy config.example.json config.json
    echo          默认 allow 列表是空的 —— 谁都不放行，只适合先看它能不能起来
    echo          完整默认值见 src\config\schema.js 里的 defaultConfig
    echo.
)

echo   node:      %NODE_VER%
echo   cwd:       %CD%
echo.
echo   ------------------------------------------------------------
echo    Ctrl+C 停止
echo   ------------------------------------------------------------
echo.

rem 参数用 %* 原样透传：--check、--loglevel=debug 这些都由 main.js 自己解析，
rem 这里不做任何拦截，免得两边各有一套规矩。
"%NODE_BIN%" src\main.js %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
    echo   [EXIT] 已正常退出
) else (
    echo   [EXIT] 退出码 %EXITCODE%
    echo          2 = 配置有问题，看上面的报错
    echo          3 = 已经有一个实例在跑，或单实例锁没放开
)

if not defined QQ_NO_PAUSE pause
exit /b %EXITCODE%

:fail
echo.
if not defined QQ_NO_PAUSE pause
exit /b 1
