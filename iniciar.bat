@echo off
setlocal
chcp 65001 >nul
title Projeto Chales Barreirinhas - Servidor PostgreSQL
color 0A

cd /d "%~dp0"

echo ========================================================
echo   PROJETO CHALES EM BARREIRINHAS - SERVIDOR LOCAL
echo   Banco de Dados: PostgreSQL
echo ========================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :node_missing
goto :check_env

:node_missing
color 0C
echo [ERRO] O Node.js nao foi encontrado no sistema.
echo Instale o Node.js 18 ou mais recente e abra um novo terminal.
echo.
pause
exit /b 1

:check_env
if exist ".env" goto :setup_paths
if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo [AVISO] O arquivo .env foi criado automaticamente a partir de .env.example.
    echo         Confira as credenciais do PostgreSQL no arquivo .env se necessario.
    echo.
)

:setup_paths
rem Configura diretorio de modulos no disco local C: para contornar bloqueios do Google Drive (drive G:)
set "MODULES_DIR=%LOCALAPPDATA%\ChalesBarreirinhas_Modules"
if not exist "%MODULES_DIR%" mkdir "%MODULES_DIR%"
set "NODE_PATH=%MODULES_DIR%\node_modules;%CD%\node_modules"

rem Se houver arquivos corrompidos de node_modules no Google Drive, remove
if exist "node_modules" (
    node -e "require('express'); require('pg')" >nul 2>nul
    if errorlevel 1 (
        echo Limpando pasta node_modules corrompida do Google Drive...
        rd /s /q "node_modules" 2>nul
    )
)

:check_deps
node -e "require('express'); require('pg')" >nul 2>nul
if errorlevel 1 goto :install_deps
goto :start_app

:install_deps
echo ========================================================
echo   Instalando dependencias no disco local C:
echo   Destino: %MODULES_DIR%
echo   (Evita o erro TAR_ENTRY_ERROR EBADF do Google Drive)
echo ========================================================
echo.

copy /y "package.json" "%MODULES_DIR%\package.json" >nul
pushd "%MODULES_DIR%"
call npm install
popd

node -e "require('express'); require('pg')" >nul 2>nul
if errorlevel 1 (
    color 0C
    echo.
    echo [ERRO] Nao foi possivel instalar as dependencias no disco local.
    echo.
    pause
    exit /b 1
)

:start_app
echo Iniciando o servidor Express com PostgreSQL...
echo.

node server.js
set "server_exit_code=%errorlevel%"

if not "%server_exit_code%"=="0" (
    echo.
    echo [AVISO] O servidor foi encerrado com erro.
    pause
)

exit /b %server_exit_code%
