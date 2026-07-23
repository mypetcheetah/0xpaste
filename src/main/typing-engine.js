'use strict';

/**
 * typing-engine.js
 *
 * Character-by-character keyboard simulation via PowerShell +
 * System.Windows.Forms.SendKeys. Typing runs entirely through SendKeys, which
 * lives inside a Microsoft-signed .NET assembly - the same path v1.0.5 used and
 * the one that stays clear of Cortex XDR (unlike raw SendInput keystroke
 * injection from runtime-compiled code, which reads as a keylogger pattern).
 *
 * The mouse focus-click still uses Win32 SendInput via Add-Type - byte-for-byte
 * the v1.0.5 code, which never triggered an alert (it moves the mouse, it does
 * not type).
 *
 * Dead keys (circumflex, backtick, apostrophe, tilde, quote) are resolved with
 * SendKeys itself: send the character, then a DIGIT, then a backspace. A digit
 * has no composition with any accent, so Windows always emits both the spacing
 * accent and the digit - on a real dead-key layout and on a plain one alike.
 * Using a space here would break on true dead-key layouts, because accent +
 * space yields the accent and swallows the space, after which the backspace
 * eats the accent itself and the character vanishes.
 *
 * Enter handling follows the autoEnter setting exactly:
 *   off - a newline in the text is typed as a space, so the paste stays on one
 *         line and Enter is NEVER pressed (important in chat apps, where Enter
 *         would send the message).
 *   on  - newlines are typed as real Enters and one final Enter is sent after
 *         the last character, in the SAME session while the target has focus.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ---- Embedded PowerShell script ----
// Params: -px,-py (screen coords), -textFile (UTF-8), -charDelay (ms),
//         -initialDelay (ms, waited after focus), -autoEnter (0|1)
const PS_SCRIPT = String.raw`
param(
    [int]$px,
    [int]$py,
    [string]$textFile,
    [int]$charDelay,
    [int]$initialDelay,
    [int]$autoEnter
)

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class OxPasteWin32 {
    // Virtual-desktop metrics (all monitors combined, physical pixels)
    const int SM_XVIRTUALSCREEN   = 76;
    const int SM_YVIRTUALSCREEN   = 77;
    const int SM_CXVIRTUALSCREEN  = 78;
    const int SM_CYVIRTUALSCREEN  = 79;

    // SendInput constants (mouse only)
    const uint INPUT_MOUSE              = 0;
    const uint MOUSEEVENTF_MOVE        = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN    = 0x0002;
    const uint MOUSEEVENTF_LEFTUP      = 0x0004;
    const uint MOUSEEVENTF_ABSOLUTE    = 0x8000;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    const uint GA_ROOT = 2;

    // INPUT struct layout matches the Windows x64 ABI exactly:
    //   type   (DWORD, 4 bytes) at offset  0
    //   [pad   (4 bytes)]       at offset  4
    //   dx     (LONG,  4 bytes) at offset  8
    //   dy     (LONG,  4 bytes) at offset 12
    //   mouseData (DWORD)       at offset 16
    //   dwFlags   (DWORD)       at offset 20
    //   time      (DWORD)       at offset 24
    //   [pad   (4 bytes)]       at offset 28
    //   dwExtraInfo (ptr)       at offset 32
    //   Total size = 40 bytes
    [StructLayout(LayoutKind.Explicit)]
    struct INPUT {
        [FieldOffset( 0)] public uint   type;
        [FieldOffset( 8)] public int    dx;
        [FieldOffset(12)] public int    dy;
        [FieldOffset(16)] public uint   mouseData;
        [FieldOffset(20)] public uint   dwFlags;
        [FieldOffset(24)] public uint   time;
        [FieldOffset(32)] public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    // Enable per-monitor DPI awareness v2 so Win32 coords are physical pixels
    [DllImport("user32.dll")]
    static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int nIndex);

    // MulDiv avoids integer overflow when normalising to 0-65535
    [DllImport("kernel32.dll")]
    static extern int MulDiv(int nNumber, int nNumerator, int nDenominator);

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern IntPtr WindowFromPoint(POINT pt);

    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

        public static void ClickAt(int x, int y) {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4):
        // all GetSystemMetrics / WindowFromPoint calls return physical pixels.
        SetThreadDpiAwarenessContext(new IntPtr(-4));

        // Virtual desktop origin and size in physical pixels
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        // Normalise physical coords to the 0-65535 range SendInput expects
        int nx = MulDiv(x - vx, 65535, vw - 1);
        int ny = MulDiv(y - vy, 65535, vh - 1);

        int cbSize = Marshal.SizeOf(typeof(INPUT));

        // 1. Move cursor to exact physical position
        INPUT[] move = new INPUT[1];
        move[0].type    = INPUT_MOUSE;
        move[0].dx      = nx;
        move[0].dy      = ny;
        move[0].dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInput(1, move, cbSize);

        System.Threading.Thread.Sleep(50);

        // 2. Bring the window under cursor to the foreground
        POINT pt; pt.X = x; pt.Y = y;
        IntPtr hwnd = WindowFromPoint(pt);
        if (hwnd != IntPtr.Zero) {
            IntPtr root = GetAncestor(hwnd, GA_ROOT);
            if (root != IntPtr.Zero) SetForegroundWindow(root);
        }

        System.Threading.Thread.Sleep(80);

        // 3. Left-button down
        INPUT[] down = new INPUT[1];
        down[0].type    = INPUT_MOUSE;
        down[0].dx      = nx;
        down[0].dy      = ny;
        down[0].dwFlags = MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInput(1, down, cbSize);

        System.Threading.Thread.Sleep(30);

        // 4. Left-button up
        INPUT[] up = new INPUT[1];
        up[0].type    = INPUT_MOUSE;
        up[0].dx      = nx;
        up[0].dy      = ny;
        up[0].dwFlags = MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInput(1, up, cbSize);
    }
}
"@

# Focus the target, then wait the configured settle time before the first key.
[OxPasteWin32]::ClickAt($px, $py)
if ($initialDelay -gt 0) { Start-Sleep -Milliseconds $initialDelay }

# Read text (handles all Unicode correctly) and drop CR so CRLF fires one Enter.
$text  = [System.IO.File]::ReadAllText($textFile, [System.Text.Encoding]::UTF8)
$chars = $text.ToCharArray() | Where-Object { [int]$_ -ne 13 }
$total = $chars.Count
if ($total -eq 0) {
    if ($autoEnter -eq 1) {
        Start-Sleep -Milliseconds 30
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    }
    Write-Host "DONE"
    exit
}

# Dead-key character codes on NL / EU layouts: circumflex 94, backtick 96,
# apostrophe 39, tilde 126, quote 34.
$i = 0
foreach ($char in $chars) {
    $i++
    $code = [int][char]$char

    # Map the character to its SendKeys representation and note whether it is a
    # dead key that must be resolved with a trailing space + backspace.
    $sendKey = $null
    $isDead  = $false
    switch ($code) {
        # Line break. With auto-enter OFF the paste must never press Enter, so
        # a newline becomes a space and everything lands on a single line.
        # With auto-enter ON the line breaks are typed as real Enters.
        10  { if ($autoEnter -eq 1) { $sendKey = '{ENTER}' } else { $sendKey = ' ' } }
        9   { $sendKey = '{TAB}' }                         # Tab
        94  { $sendKey = '{^}'; $isDead = $true }          # ^
        126 { $sendKey = '{~}'; $isDead = $true }          # ~
        34  { $sendKey = '"';  $isDead = $true }           # "
        39  { $sendKey = [string][char]39;  $isDead = $true }  # '
        96  { $sendKey = [string][char]96;  $isDead = $true }  # backtick
        43  { $sendKey = '{+}' }                           # +
        37  { $sendKey = '{%}' }                           # %
        40  { $sendKey = '{(}' }                           # (
        41  { $sendKey = '{)}' }                           # )
        123 { $sendKey = '{{}' }                           # {
        125 { $sendKey = '{}}' }                           # }
        91  { $sendKey = '{[}' }                           # [
        93  { $sendKey = '{]}' }                           # ]
        default { $sendKey = [string]$char }
    }

    if ($null -ne $sendKey) {
        try {
            if ($isDead) {
                # Resolve the dead key with a character it can NEVER combine
                # with (a digit), then delete that character again.
                #
                # Why not a space: on a real dead-key layout, accent + space
                # yields the accent and SWALLOWS the space, so the backspace
                # then eats the accent itself and the character disappears.
                # A digit has no composition with any accent, so Windows always
                # emits BOTH the spacing accent and the digit - in every
                # environment, dead-key layout or not. Backspace then removes
                # only the digit and the accent survives.
                [System.Windows.Forms.SendKeys]::SendWait($sendKey)
                [System.Windows.Forms.SendKeys]::SendWait('0')
                [System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')
            } else {
                [System.Windows.Forms.SendKeys]::SendWait($sendKey)
            }
        } catch {
            # Skip a single problematic character rather than aborting.
        }
    }

    if ($charDelay -gt 0) { Start-Sleep -Milliseconds $charDelay }

    $pct = [int]([Math]::Floor(($i / $total) * 100))
    Write-Host "PROGRESS:$pct"
    [Console]::Out.Flush()
}

# Trailing Enter in the SAME session, while the target still has focus.
if ($autoEnter -eq 1) {
    Start-Sleep -Milliseconds 30
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}

Write-Host "DONE"
[Console]::Out.Flush()
`;

// ---- State ----
const state = {
  active:           false,
  cancelled:        false,
  lastCancelled:    false,
  childProcess:     null,
  progressCallback: null
};

// ---- Main entry point ----
async function startTyping(text, x, y, settings, progressCallback) {
  state.active           = true;
  state.cancelled        = false;
  state.progressCallback = progressCallback || null;

  const { initialDelay, charDelay, autoEnter } = settings;

  const tmpText   = path.join(os.tmpdir(), `0xpaste_text_${Date.now()}.txt`);
  const tmpScript = path.join(os.tmpdir(), `0xpaste_typer_${Date.now()}.ps1`);

  try {
    fs.writeFileSync(tmpText,   text,      'utf8');
    fs.writeFileSync(tmpScript, PS_SCRIPT, 'utf8');

    if (state.cancelled) return;

    await new Promise((resolve) => {
      const psArgs = [
        '-NonInteractive',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', tmpScript,
        '-px', String(x),
        '-py', String(y),
        '-textFile', tmpText,
        '-charDelay', String(charDelay),
        '-initialDelay', String(initialDelay),
        '-autoEnter', autoEnter ? '1' : '0'
      ];

      const ps = spawn('powershell.exe', psArgs, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      state.childProcess = ps;

      let buf = '';
      ps.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith('PROGRESS:')) {
            const pct = parseInt(t.slice(9), 10);
            if (!isNaN(pct) && state.progressCallback) state.progressCallback(pct);
          }
        }
      });

      ps.stderr.on('data', (d) => {
        console.error('[typing-engine] PS stderr:', d.toString().slice(0, 300));
      });

      ps.on('close', () => { state.childProcess = null; resolve(); });
      ps.on('error', (err) => {
        console.error('[typing-engine] spawn error:', err.message);
        state.childProcess = null;
        resolve();
      });
    });

  } finally {
    try { fs.unlinkSync(tmpText);   } catch (_) {}
    try { fs.unlinkSync(tmpScript); } catch (_) {}
    state.lastCancelled    = state.cancelled;
    state.active           = false;
    state.cancelled        = false;
    state.childProcess     = null;
    state.progressCallback = null;
  }
}

function cancel() {
  state.cancelled = true;
  if (state.childProcess) {
    try { state.childProcess.kill(); } catch (_) {}
    state.childProcess = null;
  }
}

function isTyping() {
  return state.active;
}

function isAvailable() {
  return true; // PowerShell is always available on Windows 7+
}

function wasCancelled() {
  return state.lastCancelled;
}

module.exports = { startTyping, cancel, isTyping, isAvailable, wasCancelled };
