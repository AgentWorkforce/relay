; Agent Relay's Windows Setup program (Inno Setup 6.3 or later).
;
; scripts/build-windows.sh compiles it after the zips:
;
;   ISCC.exe /DVersion=<version> /DArch=x64|arm64 /DSourceDir=<tree> /DOutputDir=<dir> AgentRelay.iss
;
; SourceDir is the built AgentRelay-Windows-<arch> tree. The result is
; <OutputDir>\AgentRelay-<version>-Windows-<arch>-Setup.exe.
;
; Setup installs per user, without administrator rights, exactly where the
; zip goes and the in-app updater expects it (install/windows.rs,
; updates/windows.rs):
;
;   %LOCALAPPDATA%\Programs\AgentRelay\<version>\AgentRelay-Windows-<arch>\
;
; so a later in-app update unpacks the next version beside it. The
; uninstaller lives one level up, in %LOCALAPPDATA%\Programs\AgentRelay, so it
; outlives the version folder it was installed with, and it removes every
; version, the Start menu shortcut, the agentrelay:// handler, the
; notification identity, the app's own launch-at-login value and the
; "Agent Relay (<account>)" logon task. It never touches your data:
; %USERPROFILE%\.agentworkforce and %APPDATA%\agent-relay stay.

#ifndef Version
  #error Pass /DVersion=<version>
#endif
#ifndef Arch
  #error Pass /DArch=x64 or /DArch=arm64
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<the AgentRelay-Windows-<arch> tree>
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

#if Arch == "x64"
  #define Architectures "x64compatible"
#elif Arch == "arm64"
  #define Architectures "arm64"
#else
  #error Arch must be x64 or arm64
#endif

; Windows' file version is four numbers: a prerelease suffix is dropped.
#if Pos("-", Version) > 0
  #define NumericVersion Copy(Version, 1, Pos("-", Version) - 1)
#else
  #define NumericVersion Version
#endif

; Fixed for every release: Windows lists one Agent Relay, and Setup upgrades
; it. The uninstall entry is HKCU\Software\Microsoft\Windows\CurrentVersion\
; Uninstall\{<AppGuid>}_is1 (install::windows::UNINSTALL_KEY), which an
; in-app update keeps on the version it installs.
#define AppGuid "C5377993-AE99-466F-A519-676A299A6C6D"
#define Tree "AgentRelay-Windows-" + Arch

[Setup]
AppId={{{#AppGuid}}
AppName=Agent Relay
AppVersion={#Version}
AppVerName=Agent Relay {#Version}
AppPublisher=Agent Relay
AppPublisherURL=https://agentrelay.com
AppSupportURL=https://github.com/AgentWorkforce/relay-desktop-releases
VersionInfoVersion={#NumericVersion}
VersionInfoProductName=Agent Relay
VersionInfoDescription=Agent Relay Setup
; Per user, no UAC prompt.
PrivilegesRequired=lowest
ArchitecturesAllowed={#Architectures}
ArchitecturesInstallIn64BitMode={#Architectures}
; Each version in its own folder, as the in-app updater lays them out; never
; the folder an earlier version was installed in.
DefaultDirName={localappdata}\Programs\AgentRelay\{#Version}\{#Tree}
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
UninstallFilesDir={localappdata}\Programs\AgentRelay
UninstallDisplayName=Agent Relay
UninstallDisplayIcon={app}\bin\agent-relay-desktop.exe
#if FileExists(AddBackslash(SourceDir) + "share\icons\agent-relay.ico")
SetupIconFile={#SourceDir}\share\icons\agent-relay.ico
#endif
WizardStyle=modern
OutputDir={#OutputDir}
OutputBaseFilename=AgentRelay-{#Version}-Windows-{#Arch}-Setup
Compression=lzma2/max
SolidCompression=yes
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; The path the app writes itself (install::windows::SHORTCUT), so the two agree.
Name: "{userprograms}\Agent Relay"; Filename: "{app}\bin\agent-relay-desktop.exe"; WorkingDir: "{app}\bin"; Comment: "Agent Relay"
Name: "{userdesktop}\Agent Relay"; Filename: "{app}\bin\agent-relay-desktop.exe"; WorkingDir: "{app}\bin"; Comment: "Agent Relay"; Tasks: desktopicon

[Run]
; The shortcut, the agentrelay:// handler and the notification identity, as
; the app writes them on its first start, also after a silent install.
Filename: "{app}\bin\agent-relay-desktop.exe"; Parameters: "--install-launcher"; Flags: runhidden waituntilterminated
Filename: "{app}\bin\agent-relay-desktop.exe"; Description: "{cm:LaunchProgram,Agent Relay}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Every version, including those in-app updates installed, and the
; uninstaller's own folder. Never %APPDATA%\agent-relay or ~\.agentworkforce.
Type: filesandordirs; Name: "{localappdata}\Programs\AgentRelay"
Type: files; Name: "{userprograms}\Agent Relay.lnk"
Type: files; Name: "{userdesktop}\Agent Relay.lnk"

[Code]
const
  ProtocolKey = 'Software\Classes\agentrelay';
  AppUserModelKey = 'Software\Classes\AppUserModelId\AgentWorkforce.AgentRelay';
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  RunValue = 'AgentRelay';

{ %LOCALAPPDATA%\Programs\AgentRelay, lowercase, with a trailing backslash. }
function InstallRoot: String;
begin
  Result := Lowercase(AddBackslash(ExpandConstant('{localappdata}\Programs\AgentRelay')));
end;

{ The logon task's name, as service::windows::name builds it from USERNAME:
  "Agent Relay (alice)", or "Agent Relay" without a user name. }
function TaskName: String;
var
  User: String;
begin
  User := GetEnv('USERNAME');
  if User = '' then
    Result := 'Agent Relay'
  else
    Result := 'Agent Relay (' + User + ')';
end;

{ value as a PowerShell single-quoted string. }
function PsQuote(Value: String): String;
begin
  StringChangeEx(Value, '''', '''''', True);
  Result := '''' + Value + '''';
end;

{ Runs a PowerShell command hidden and waits for it; the exit code, or -1. }
function PowerShell(Command: String): Integer;
var
  Code: Integer;
begin
  if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Command + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Result := Code
  else
    Result := -1;
end;

{ Ends the Agent Relay programs running from the install root: the current or
  legacy window only (without --headless), or every program there. }
procedure StopRunning(Everything: Boolean);
var
  Filter: String;
begin
  if Everything then
    Filter := '$true'
  else
    Filter := '(($_.Name -ieq ''agent-relay-desktop.exe'' -or $_.Name -ieq ''agent-relay.exe'') -and $_.CommandLine -notmatch ''--headless'')';
  PowerShell('$root = ' + PsQuote(InstallRoot) + '; ' +
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ' +
    '$_.ExecutablePath.ToLower().StartsWith($root) -and ' + Filter + ' } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }');
end;

{ An open window of an older version would take the new one's launch (one
  instance per account), so it is closed first. The background service
  keeps running; it moves to the new version after the files are in place. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunning(False);
  Result := '';
end;

{ As an in-app update does (updates::windows::repoint_task): the logon task,
  if there is one, runs the new version, keeping whether it is on, and a
  running task restarts on it. A task the person never created is left to
  the app, which registers it off on its first start. False when the task
  could not be moved or restarted. }
function RepointTask: Boolean;
var
  Exe: String;
begin
  Exe := ExpandConstant('{app}\bin\agent-relay-desktop.exe');
  Result := PowerShell('$ErrorActionPreference = ''Stop''; ' +
    '$task = Get-ScheduledTask -TaskPath ''\'' -TaskName ' + PsQuote(TaskName) + ' -ErrorAction SilentlyContinue; ' +
    'if (-not $task -or $task.Actions[0].Execute -ieq ' + PsQuote(Exe) + ') { exit 0 }; ' +
    '$running = $task.State -eq ''Running''; ' +
    'if ($running) { Stop-ScheduledTask -InputObject $task }; ' +
    '$task.Actions[0].Execute = ' + PsQuote(Exe) + '; ' +
    'Set-ScheduledTask -InputObject $task | Out-Null; ' +
    'if ($running) { Start-ScheduledTask -TaskPath ''\'' -TaskName ' + PsQuote(TaskName) + ' }') = 0;
end;

{ Whether a registry command runs a program under the install root. }
function RunsFromRoot(Command: String): Boolean;
begin
  Result := Pos(InstallRoot, Lowercase(Command)) > 0;
end;

{ The Run value this app writes: "<...>\agent-relay-desktop.exe" --background.
  The legacy name is recognized so upgrades can move or remove it
  (relay::login_item::windows::owned). }
function RunValueIsOurs(Command: String): Boolean;
begin
  Command := Lowercase(Command);
  Result := ((Pos('agent-relay-desktop.exe', Command) > 0) or
    (Pos('agent-relay.exe', Command) > 0)) and (Pos('--background', Command) > 0);
end;

{ As an in-app update does (relay::login_item::windows::follow): Launch at
  login, when it is this app's own Run value, opens the new version at the
  next sign-in. Someone else's value, and no value, are left alone. }
procedure RepointRunValue;
var
  Command: String;
  Exe: String;
begin
  Exe := ExpandConstant('{app}\bin\agent-relay-desktop.exe');
  if RegQueryStringValue(HKCU, RunKey, RunValue, Command) and RunValueIsOurs(Command) then
    RegWriteStringValue(HKCU, RunKey, RunValue, '"' + Exe + '" --background');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    RepointRunValue;
    if not RepointTask then
      SuppressibleMsgBox(
        'The background service could not be moved to this version of Agent Relay.' + #13#10 + #13#10 +
        'Open Agent Relay, go to Settings and turn Background service off and on again to restart it.',
        mbError, MB_OK, IDOK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  Command: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    { Uninstalling is the one time the logon task is ended and removed. }
    Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN "' + TaskName + '"', '',
      SW_HIDE, ewWaitUntilTerminated, Code);
    Exec(ExpandConstant('{sys}\schtasks.exe'), '/Delete /TN "' + TaskName + '" /F', '',
      SW_HIDE, ewWaitUntilTerminated, Code);
    StopRunning(True);
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    { Only entries that run this install; someone else's are kept. }
    if RegQueryStringValue(HKCU, ProtocolKey + '\shell\open\command', '', Command) and
      RunsFromRoot(Command) then
      RegDeleteKeyIncludingSubkeys(HKCU, ProtocolKey);
    RegDeleteKeyIncludingSubkeys(HKCU, AppUserModelKey);
    if RegQueryStringValue(HKCU, RunKey, RunValue, Command) and RunValueIsOurs(Command) then
      RegDeleteValue(HKCU, RunKey, RunValue);
  end;
end;
