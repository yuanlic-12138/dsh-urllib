' dsh-urllib launcher (no console flash).
' Runs start-urllib.ps1 completely hidden, then exits.
' NOTE: keep this file ASCII-only.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\start-urllib.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """"
sh.Run cmd, 0, False
