; Repair only the exact broken 0.2.3 uninstaller shipped by this project.
; Keep the original for recovery; never disable NSIS integrity verification.
!macro customInit
  ReadRegStr $R6 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R6 != ""
    ${If} ${FileExists} "$R6\Uninstall Agent Messenger.exe"
      ${StdUtils.HashFile} $R7 "SHA2-256" "$R6\Uninstall Agent Messenger.exe"
      ${If} $R7 == "0fe8537da2e750ca988093e3a593b74af0d3ff53b0a7225c0275c78e96fb0d6b"
        CreateDirectory "$LOCALAPPDATA\AgentMessenger Installer Backups"
        ClearErrors
        CopyFiles /SILENT "$R6\Uninstall Agent Messenger.exe" "$LOCALAPPDATA\AgentMessenger Installer Backups\uninstaller-0.2.3.exe"
        IfErrors repair_failed
        SetOutPath "$R6"
        File "/oname=Uninstall Agent Messenger.exe" "${UNINSTALLER_OUT_FILE}"
        IfErrors repair_failed
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Goto repair_done
  repair_failed:
    MessageBox MB_OK|MB_ICONSTOP "기존 앱 복구 파일을 저장하지 못했습니다. 앱을 완전히 종료한 뒤 다시 설치해 주세요."
    Abort
  repair_done:
!macroend
