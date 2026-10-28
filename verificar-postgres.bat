@echo off
setlocal
chcp 65001 >nul
color 0A
title Verificacao do PostgreSQL

echo ========================================================
echo   DIAGNOSTICO: VERIFICANDO POSTGRESQL NESTE COMPUTADOR
echo ========================================================
echo.

set "ACHOU=0"

where psql >nul 2>nul
if %errorlevel% equ 0 (
    set "ACHOU=1"
    echo [1/3] Executavel 'psql' encontrado no sistema:
    where psql
) else (
    echo [1/3] Executavel 'psql' NAO encontrado no sistema.
)
echo.

echo [2/3] Verificando servicos do Windows...
powershell -Command "Get-Service *postgres* -ErrorAction SilentlyContinue | Select-Object Name, DisplayName, Status"
echo.

echo [3/3] Verificando pastas padrao de instalacao...
if exist "C:\Program Files\PostgreSQL" (
    set "ACHOU=1"
    echo [OK] Encontrada pasta: C:\Program Files\PostgreSQL
    dir /b "C:\Program Files\PostgreSQL"
) else if exist "C:\Program Files (x86)\PostgreSQL" (
    set "ACHOU=1"
    echo [OK] Encontrada pasta: C:\Program Files (x86)\PostgreSQL
) else (
    echo [NAO ENCONTRADO] Nenhuma pasta do PostgreSQL encontrada em Arquivos de Programas.
)

echo.
echo ========================================================
if %ACHOU% equ 0 (
    color 0C
    echo   RESULTADO: O PostgreSQL NAO esta instalado neste PC.
    echo ========================================================
    echo.
    echo Como voce nao tem o PostgreSQL instalado localmente,
    echo voce pode instalar agora ou usar uma solucao gratuita na nuvem.
) else (
    color 0B
    echo   RESULTADO: O PostgreSQL foi detectado!
    echo ========================================================
)
echo.
pause

