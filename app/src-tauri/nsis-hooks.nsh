; Tauri's stock NSIS template drops a shortcut on the Desktop with no config
; switch to turn it off (NsisConfig has no createDesktopShortcut key). The
; Desktop is a work surface here, not an icon dump, so remove the shortcut
; right after install and again on uninstall in case an older build left one.
;
; Wired via bundle.windows.nsis.installerHooks in tauri.conf.json.
;
; Two template variables are easy to confuse and both appear below. They are no
; longer the same string, which is the point of the 29 July 2026 naming
; decision:
;   ${PRODUCTNAME}    "Photo Pigeon", from productName. The display name.
;                     It names the Start Menu entry, the shortcuts, the install
;                     directory ($LOCALAPPDATA\${PRODUCTNAME}) and the HKCU Run
;                     value the uninstaller deletes.
;   ${MAINBINARYNAME} "photo-pigeon", from mainBinaryName. Names the exe, and
;                     is FROZEN: it is a machine identifier and does not follow
;                     the display name.
;
; The Start Menu shortcut must keep being created: it is what carries the
; AppUserModelID, and without it Windows files our toasts under whatever process
; launched us. See TRAY-DESIGN sections 1 and 5.
;
; What is deliberately NOT here: any attempt to clean up an install made under
; the old product name. NSIS keys its uninstall entry on ${PRODUCTNAME}, so an
; older %LOCALAPPDATA%\photo-pigeon install is a different product to this
; installer and is neither upgraded nor removed. Deleting another product's
; directory from a hook is exactly the kind of helpfulness that eats somebody's
; data, so the old copy is uninstalled by hand, with its own uninstaller.
; Neither path goes anywhere near ~/.photo-pigeon, which no installer or
; uninstaller in this project may touch.

!macro NSIS_HOOK_POSTINSTALL
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"

  ; The exe was renamed from photo-pigeon-tray.exe to photo-pigeon.exe on
  ; 28 July 2026. The stock template already deletes the previous binary by
  ; reading MainBinaryName back out of the uninstall key, so this line only
  ; covers an install whose key was never written or was cleaned by hand. It is
  ; a one-time courtesy for machines that ran the M0 build and can be deleted
  ; once 1.0 has shipped.
  Delete "$INSTDIR\photo-pigeon-tray.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
!macroend
