@echo off
rem Atelier MEG - active la mise a jour automatique de l'extension (a faire une seule fois).
rem Cree une tache planifiee Windows (utilisateur courant, sans droits administrateur)
rem qui verifie toutes les 2 heures et a chaque ouverture de session.
set "VBS=%~dp0lancer-maj.vbs"
schtasks /Create /F /TN "Atelier MEG - mise a jour" /SC HOURLY /MO 2 /TR "wscript.exe \"%VBS%\"" >nul
if errorlevel 1 goto erreur
schtasks /Create /F /TN "Atelier MEG - mise a jour (ouverture de session)" /SC ONLOGON /TR "wscript.exe \"%VBS%\"" >nul 2>&1
wscript.exe "%VBS%"
echo.
echo  Mise a jour automatique d'Atelier MEG ACTIVEE.
echo  L'extension se mettra a jour toute seule (verification toutes les 2 heures).
echo  Journal : %~dp0maj.log
echo.
pause
exit /b 0
:erreur
echo.
echo  Impossible de creer la tache planifiee. Contactez votre administrateur.
echo.
pause
exit /b 1
