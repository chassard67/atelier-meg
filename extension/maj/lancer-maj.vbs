' Lance mettre-a-jour.ps1 sans fenetre (utilise par la tache planifiee).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\mettre-a-jour.ps1""", 0, False
