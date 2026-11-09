; Instalador do Nexo para Windows 10/11 (64 bits).
; - Instala o aplicativo e, opcionalmente, o servidor da rede local.
; - Cria as regras do Windows Defender Firewall NA INSTALAÇÃO (um único "Sim" de administrador),
;   para que o Windows nunca mais pergunte sobre o Firewall.
; - Instala o WebView2 se estiver faltando (Windows 10 antigo).
; Gerado por installer/windows/build.sh (que prepara a pasta "staging").

Unicode true
ManifestDPIAware true
!define APPNAME "Nexo"
!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!define PUBLISHER "Nexo"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nexo"
!define WV2KEY "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${APPNAME}"
OutFile "Nexo-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\Nexo"
InstallDirRegKey HKLM "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "Nexo ${VERSION}"

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"

!define MUI_ICON "staging\nexo.ico"
!define MUI_UNICON "staging\nexo.ico"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC

!define MUI_WELCOMEPAGE_TITLE "Instalar o Nexo"
!define MUI_WELCOMEPAGE_TEXT "O Nexo permite acessar e controlar outro computador, sempre com autorização de quem está nele.$\r$\n$\r$\nEste instalador também libera o Nexo no Firewall do Windows, para que nenhum aviso de Firewall apareça depois.$\r$\n$\r$\nClique em Próximo para continuar."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\Nexo.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir o Nexo agora"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=${LANG_PORTUGUESEBR} "ProductName" "Nexo"
VIAddVersionKey /LANG=${LANG_PORTUGUESEBR} "FileDescription" "Instalador do Nexo"
VIAddVersionKey /LANG=${LANG_PORTUGUESEBR} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_PORTUGUESEBR} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_PORTUGUESEBR} "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=${LANG_PORTUGUESEBR} "LegalCopyright" "${PUBLISHER}"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "O Nexo requer Windows 64 bits."
    Abort
  ${EndIf}
  SetRegView 64
FunctionEnd

!macro FirewallRule NAME PROGRAM
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${NAME}"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${NAME}" dir=in action=allow program="${PROGRAM}" enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${NAME}" dir=out action=allow program="${PROGRAM}" enable=yes profile=any'
!macroend

Section "Nexo (aplicativo)" SecApp
  SectionIn RO
  ; Fecha uma versão aberta para poder substituir os arquivos.
  nsExec::Exec 'taskkill /IM Nexo.exe /F'
  SetOutPath "$INSTDIR"
  File "staging\app\Nexo.exe"
  File "staging\app\*.dll"
  File "staging\nexo.ico"

  ; WebView2 (já presente no Windows 11 e no Windows 10 atualizado).
  ReadRegStr $0 HKLM "${WV2KEY}" "pv"
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    DetailPrint "Instalando o Microsoft WebView2..."
    SetOutPath "$PLUGINSDIR"
    File "staging\MicrosoftEdgeWebview2Setup.exe"
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install'
    SetOutPath "$INSTDIR"
  ${EndIf}

  DetailPrint "Liberando o Nexo no Firewall do Windows..."
  !insertmacro FirewallRule "Nexo" "$INSTDIR\Nexo.exe"

  CreateDirectory "$SMPROGRAMS\Nexo"
  CreateShortcut "$SMPROGRAMS\Nexo\Nexo.lnk" "$INSTDIR\Nexo.exe" "" "$INSTDIR\nexo.ico"
  CreateShortcut "$DESKTOP\Nexo.lnk" "$INSTDIR\Nexo.exe" "" "$INSTDIR\nexo.ico"
  CreateShortcut "$SMPROGRAMS\Nexo\Desinstalar o Nexo.lnk" "$INSTDIR\Desinstalar.exe"

  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "Nexo"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\nexo.ico"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section /o "Servidor Nexo (apenas 1 computador da rede)" SecServer
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"$INSTDIR\Servidor\*\" } | Stop-Process -Force"'
  SetOutPath "$INSTDIR\Servidor"
  File /r "staging\server\*.*"
  DetailPrint "Liberando o servidor no Firewall do Windows..."
  !insertmacro FirewallRule "Nexo Servidor" "$INSTDIR\Servidor\node\node.exe"
  CreateShortcut "$SMPROGRAMS\Nexo\Servidor Nexo.lnk" "$INSTDIR\Servidor\Iniciar servidor Nexo.bat" "" "$INSTDIR\nexo.ico"
  CreateShortcut "$DESKTOP\Servidor Nexo.lnk" "$INSTDIR\Servidor\Iniciar servidor Nexo.bat" "" "$INSTDIR\nexo.ico"
  ; O servidor precisa estar sempre disponível: abre minimizado quando o Windows inicia.
  CreateShortcut "$SMSTARTUP\Servidor Nexo.lnk" "$INSTDIR\Servidor\Iniciar servidor Nexo.bat" "" "$INSTDIR\nexo.ico" 0 SW_SHOWMINIMIZED
SectionEnd


Section "-Abrir servidor ao final"
  ${If} ${SectionIsSelected} ${SecServer}
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\Servidor\Iniciar servidor Nexo.bat"'
  ${EndIf}
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecApp} "O aplicativo Nexo. Instale em todos os computadores."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecServer} "Servidor que entrega os IDs e coloca os computadores em contato. Marque em apenas UM computador da rede (ele precisa ficar ligado). Abre sozinho quando o Windows inicia."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  SetRegView 64
  nsExec::Exec 'taskkill /IM Nexo.exe /F'
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"$INSTDIR\Servidor\*\" } | Stop-Process -Force"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Nexo"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Nexo Servidor"'
  Delete "$DESKTOP\Nexo.lnk"
  Delete "$DESKTOP\Servidor Nexo.lnk"
  Delete "$SMSTARTUP\Servidor Nexo.lnk"
  RMDir /r "$SMPROGRAMS\Nexo"
  RMDir /r /REBOOTOK "$INSTDIR\Servidor"
  Delete "$INSTDIR\Nexo.exe"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\nexo.ico"
  Delete "$INSTDIR\Desinstalar.exe"
  RMDir /REBOOTOK "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTKEY}"
SectionEnd
