; Custom NSIS script for 0xpaste
;
; KEY FIX: nsExec::Exec on 64-bit Windows hits WOW64 filesystem redirection -
; NSIS is a 32-bit process, so $SYSDIR resolves to SysWOW64, and the 32-bit
; taskkill cannot see 64-bit Electron processes. We must disable the redirection
; and use ExecWait (not nsExec) so the kill actually works.
; /T kills the full process tree (Electron spawns multiple child processes).

!include "x64.nsh"

; customInit fires at the start of the INSTALLER too - kills any running
; instance before installing/updating so files are never locked.
!macro customInit
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  ExecWait 'taskkill /F /T /IM "0xpaste.exe"'
  Sleep 2000
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
!macroend

; customUnInit fires at the start of the UNINSTALLER, before any files are
; touched - the only safe place to kill the process.
!macro customUnInit
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  ExecWait 'taskkill /F /T /IM "0xpaste.exe"'
  Sleep 2000
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
!macroend

; customUnInstall fires after file deletion - safe for registry/AppData only.
!macro customUnInstall
  ; Remove auto-start registry entry added by app.setLoginItemSettings
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "0xpaste"
  ; Fallback AppData cleanup (primary handled by deleteAppDataOnUninstall:true)
  RMDir /r "$APPDATA\0xpaste"
!macroend

!macro customInstall
!macroend
