@echo off
rem Atelier MEG - desactive la mise a jour automatique de l'extension.
schtasks /Delete /F /TN "Atelier MEG - mise a jour" >nul 2>&1
schtasks /Delete /F /TN "Atelier MEG - mise a jour (ouverture de session)" >nul 2>&1
echo.
echo  Mise a jour automatique d'Atelier MEG desactivee.
echo.
pause
