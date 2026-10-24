@echo off
setlocal
chcp 65001 >nul
title Projeto Chales Barreirinhas - Servidor SQLite
color 0A

cd /d "%~dp0"

echo ========================================================
echo   PROJETO CHALES EM BARREIRINHAS - SERVIDOR LOCAL
echo   Banco de Dados: SQLite (data\database.sqlite)
echo ========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    color 0C
    echo [ERRO] O Node.js nao foi encontrado no sistema.
    echo Instale o Node.js 22 ou mais recente e abra um novo terminal.
    echo.
    pause
    exit /b 1
)

node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 (
    color 0C
    echo [ERRO] Este projeto precisa do Node.js 22 ou mais recente para usar SQLite.
    echo Atualize o Node.js e tente novamente.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\express\package.json" (
    echo Instalando as dependencias do projeto...
    call npm install
    if errorlevel 1 (
        color 0C
        echo [ERRO] Nao foi possivel instalar as dependencias.
        pause
        exit /b 1
    )
)

echo Iniciando o servidor Express com SQLite...
echo.

node server.js
set "server_exit_code=%errorlevel%"

if not "%server_exit_code%"=="0" (
    echo.
    echo [AVISO] O servidor foi encerrado com erro.
    pause
)

exit /b %server_exit_code%

