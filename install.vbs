' dsh-urllib installer launcher.
' Runs install.ps1 in a visible console window and waits for it to finish.
' NOTE: keep this file ASCII-only.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\install.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """"
sh.Run cmd, 1, True
