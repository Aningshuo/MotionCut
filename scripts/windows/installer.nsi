Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MotionCut"
!define OWNER_FILE ".motioncut-install.ini"
!define OWNER_ID "com.opencut.studio"

Name "MotionCut"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\MotionCut"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
SetCompressor /SOLID lzma

VIProductVersion "${WINDOWS_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "MotionCut"
VIAddVersionKey /LANG=1033 "CompanyName" "Aningshuo"
VIAddVersionKey /LANG=1033 "FileDescription" "MotionCut Windows x64 Installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) 2026 Aningshuo"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Var TargetReady
LangString UnsupportedOS ${LANG_ENGLISH} "MotionCut requires 64-bit Windows 10 or a later version."
LangString UnsupportedOS ${LANG_SIMPCHINESE} "MotionCut 需要 64 位 Windows 10 或更高版本。"
LangString TargetOccupied ${LANG_ENGLISH} "Choose an empty folder or reinstall over the same MotionCut version. Uninstall an older version before installing into its folder."
LangString TargetOccupied ${LANG_SIMPCHINESE} "请选择空文件夹，或重装相同版本的 MotionCut。若要安装到旧版目录，请先卸载旧版。"
LangString CopyFailed ${LANG_ENGLISH} "MotionCut could not write the installation files. Close MotionCut and check that the folder is writable."
LangString CopyFailed ${LANG_SIMPCHINESE} "无法写入安装文件。请关闭 MotionCut，并确认目标文件夹可写。"

Function CheckInstallDirectory
  StrCpy $TargetReady 0
  IfFileExists "$INSTDIR\." ExistingDirectory
  IfFileExists "$INSTDIR" End
  StrCpy $TargetReady 1
  Goto End

ExistingDirectory:
  ClearErrors
  FindFirst $0 $1 "$INSTDIR\*"
  IfErrors End
ScanDirectory:
  StrCmp $1 "." NextEntry
  StrCmp $1 ".." NextEntry
  FindClose $0
  ReadRegStr $1 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  StrCmp $1 "$INSTDIR" 0 End
  ReadINIStr $1 "$INSTDIR\${OWNER_FILE}" "MotionCut" "Product"
  StrCmp $1 "${OWNER_ID}" 0 End
  ReadINIStr $1 "$INSTDIR\${OWNER_FILE}" "MotionCut" "Version"
  StrCmp $1 "${VERSION}" 0 End
  IfFileExists "$INSTDIR\Uninstall.exe" AllowTarget End
NextEntry:
  FindNext $0 $1
  IfErrors EmptyDirectory
  Goto ScanDirectory
EmptyDirectory:
  FindClose $0
AllowTarget:
  StrCpy $TargetReady 1
End:
FunctionEnd

Function .onVerifyInstDir
  Call CheckInstallDirectory
  StrCmp $TargetReady 1 IsReady
  Abort
IsReady:
FunctionEnd

Function .onInit
  SetRegView 64
  ${If} ${RunningX64}
  ${AndIf} ${AtLeastWin10}
    Return
  ${EndIf}
  IfSilent +2
  MessageBox MB_OK|MB_ICONSTOP "$(UnsupportedOS)"
  SetErrorLevel 2
  Abort
FunctionEnd

Section "MotionCut"
  SetShellVarContext current
  SetRegView 64
  Call CheckInstallDirectory
  StrCmp $TargetReady 1 Install
  IfSilent +2
  MessageBox MB_OK|MB_ICONSTOP "$(TargetOccupied)"
  SetErrorLevel 3
  Abort
Install:
  ClearErrors
  SetOutPath "$INSTDIR"
  IfErrors WriteFailed
  File /r "${PAYLOAD}\*.*"
  IfErrors WriteFailed
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  IfErrors WriteFailed
  WriteINIStr "$INSTDIR\${OWNER_FILE}" "MotionCut" "Product" "${OWNER_ID}"
  WriteINIStr "$INSTDIR\${OWNER_FILE}" "MotionCut" "Version" "${VERSION}"
  IfErrors WriteFailed
  CreateShortcut "$SMPROGRAMS\MotionCut.lnk" "$INSTDIR\MotionCut.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "MotionCut"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Aningshuo"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\MotionCut.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  IfErrors WriteFailed
  Goto Finish
WriteFailed:
  IfSilent +2
  MessageBox MB_OK|MB_ICONSTOP "$(CopyFailed)"
  SetErrorLevel 4
  Abort
Finish:
SectionEnd

Function un.onInit
  ReadINIStr $0 "$INSTDIR\${OWNER_FILE}" "MotionCut" "Product"
  StrCmp $0 "${OWNER_ID}" 0 Unsafe
  ReadINIStr $0 "$INSTDIR\${OWNER_FILE}" "MotionCut" "Version"
  StrCmp $0 "${VERSION}" Safe
Unsafe:
  SetErrorLevel 3
  Abort
Safe:
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  SetOutPath "$TEMP"
  !include "${MANIFEST}"
  Delete "$INSTDIR\${OWNER_FILE}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  StrCmp $0 "$INSTDIR" 0 Done
  Delete "$SMPROGRAMS\MotionCut.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
Done:
SectionEnd
