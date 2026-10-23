# PROJECT NEXUS V2.3 — PHASE 11: LOCK-SCREEN VOICE INTERACTION FEASIBILITY & THREAT ANALYSIS

**Document Identifier:** `NEXUS-DOC-PHASE11-LOCKSCREEN-2026-10-23`  
**Classification:** Windows Systems & Application Security Architecture  
**Role:** Principal Windows Systems Engineer & Application Security Architect  
**Authoritative Verdict:** 🔴 **FULL LOCK-SCREEN AUTONOMOUS VOICE INTERACTION REJECTED**  
**Approved Restricted Fallback:** 🟡 **OPTIONAL LOCK-STATE CHIME / ACCESS DENIED ANNOUNCEMENT ONLY**

---

## 1. Executive Summary

A core objective of Project NEXUS V2.3 is to establish an autonomous, voice-first desktop companion for Windows 11 while enforcing zero-trust, fail-closed security principles. Phase 11 evaluates the feasibility, platform mechanics, and threat profile of permitting voice interaction while the Windows workstation is in a locked state (`WTS_SESSION_LOCK`).

Following rigorous technical analysis of Windows operating system architecture, the Win32 subsystem, Session isolation boundaries, and physical acoustic threat vectors, the security verdict is unambiguous:

> **Formal Architecture Ruling:**  
> **Autonomous voice execution, large language model inference, tool execution, and contextual spoken output while the Windows workstation is locked are FORMALLY REJECTED.**  
>  
> The system must transition to `SESSION_LOCKED` upon `WTS_SESSION_LOCK`, disarm active tool execution, suppress floating UI elements, and refuse LLM generation until the user completes interactive Windows authentication (`WTS_SESSION_UNLOCK`).

---

## 2. Windows Platform Architecture & Security Boundaries

### 2.1 Session 0 & Desktop Isolation
Windows NT implements strict isolation boundaries to mitigate shatter attacks, privilege escalation, and unauthorized input/output capture:
1. **Session 0 Isolation (Windows Vista+):**
   - Services and background daemons execute in Session 0, completely isolated from interactive user sessions (Session 1, 2, ...).
   - Session 0 processes cannot create interactive windows, access user message loops, or inject input into user desktop sessions.
2. **The Secure Desktop (`Winlogon` / `LogonUI`):**
   - When the workstation is locked (`Win+L` or timeout), Windows switches from the user's `Default` desktop (`winsta0\default`) to the secure `Winlogon` desktop (`winsta0\Winlogon`).
   - Standard user-session applications executing on `winsta0\default` remain running in the background, but their windows are hidden from the physical display and cannot receive mouse or keyboard input from the physical console.
   - Injecting layered windows (such as the NEXUS floating orb) onto `winsta0\Winlogon` requires either running as `NT AUTHORITY\SYSTEM` with desktop-switch privileges or installing custom Credential Providers. This violates zero-trust least privilege principles and introduces attack surface into the Windows Logon subsystem.

### 2.2 Audio Subsystem Behavior During Lock
Windows Audio Session API (WASAPI) and the legacy Windows Multimedia (`winmm.dll`) subsystem exhibit distinct behavior during lock:
- **Audio Capture (`waveIn` / WASAPI Capture):**
  - Physical microphone capture streams remain accessible to Session 1 background processes even when the workstation is locked. The OS does not automatically mute or disconnect microphone handles upon `WTS_SESSION_LOCK`.
  - While this makes background acoustic listening *technically feasible*, it introduces severe acoustic security vulnerabilities when the legitimate operator is physically absent.
- **Display Power vs. Session Lock:**
  - Display power-off (`GUID_MONITOR_POWER_ON` / `GUID_CONSOLE_DISPLAY_STATE` set to 0) can occur while the session is unlocked (e.g., power-saving screen dimming).
  - Conversely, the session may be locked (`WTS_SESSION_LOCK`) while the display remains illuminated (e.g., the Windows Lock Screen displaying time and wallpaper).
  - **Critical Invariant:** Screen wake alone must NEVER grant unlocked privileges. Authorization must strictly bind to `WTS_SESSION_UNLOCK`.

---

## 3. Comprehensive Threat Modeling & Risk Analysis

The following threat vectors were analyzed across the lock-screen attack surface:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              LOCK-SCREEN THREAT MATRIX                                │
├───────────────────────────────────┬──────────────┬─────────────────────────────────────┤
│ Threat Vector                     │ Severity     │ Architectural Impact                │
├───────────────────────────────────┼──────────────┼─────────────────────────────────────┤
│ Physical Acoustic Spoofing        │ 🔴 CRITICAL  │ Attacker near locked laptop issues  │
│ & Replay Attacks                  │              │ voice commands to trigger actions.  │
├───────────────────────────────────┼──────────────┼─────────────────────────────────────┤
│ Ambient Confidential Information  │ 🔴 CRITICAL  │ Assistant speaks calendar, emails,  │
│ Leakage via TTS                   │              │ or files to an empty/public room.   │
├───────────────────────────────────┼──────────────┼─────────────────────────────────────┤
│ Side-Channel Tool Invocation      │ 🔴 HIGH      │ Malicious prompt injection executes │
│ (L1-L3 Tool Execution)            │              │ file writes/commands while locked.  │
├───────────────────────────────────┼──────────────┼─────────────────────────────────────┤
│ False Positive Triggering &       │ 🟡 MEDIUM    │ Background TV/conversation triggers │
│ Unattended Power Drain            │              │ battery drain & continuous logging. │
└───────────────────────────────────┴──────────────┴─────────────────────────────────────┘
```

### Threat 1: Physical Acoustic Spoofing & Replay Attacks
In an office, conference room, coffee shop, or shared living space, a user locks their PC and steps away. 
- Without biometrically authenticated speaker recognition (voiceprints verified with anti-spoofing liveness), anyone within vocal range can issue commands ("Hey NEXUS, send email...", "Hey NEXUS, open recent files...").
- Prerecorded audio or voice-cloning synthesis played from a smartphone can activate the wake phrase and prompt the assistant.
- Allowing tool invocation on a locked machine completely nullifies the physical security protection provided by Windows BitLocker and Logon credentials.

### Threat 2: Ambient Eavesdropping & Information Disclosure via TTS
When an assistant answers questions aloud, speech emanates from the device speakers:
- Prompts querying sensitive project data, source code, personal finances, or scheduling details are spoken into the physical environment.
- If an unattended query is processed while locked, acoustic eavesdropping exposes confidential data to third parties.

### Threat 3: Side-Channel Tool Invocation & Least Privilege Violation
NEXUS tools span multiple privilege tiers:
- **L0 (Read-Only System Queries):** Time, battery, CPU telemetry.
- **L1 (Safe File Read / Read-Only Knowledge):** Reading workspace notes, configs.
- **L2 (Controlled File Operations):** Writing temporary notes, modifying code.
- **L3 (Shell Execution / System Configuration):** Running batch scripts, CLI commands.
Executing any L1–L3 operation while the device is locked violates the zero-trust principle: an locked device must be considered untrusted for mutating or sensitive operations.

---

## 4. Architectural Decision & Approved Lock-State Behavior

### 4.1 Formally Approved Behavior: Fail-Closed Lockdown
The NEXUS architecture adopts the following fail-closed specification:

1. **Session Lock Event (`WTS_SESSION_LOCK`):**
   - The native desktop companion (`NexusDesktopCompanion.exe`) receives the Win32 notification via `WTSRegisterSessionNotification`.
   - The companion immediately disarms active speech synthesis (`SpeakAsyncCancelAll()`) and sets its internal state to `SESSION_LOCKED`.
   - The floating orb is immediately hidden (`HideOrb()`) to avoid drawing on an invisible desktop.
   - The Gateway Policy Engine receives the `heartbeat` with `sessionState: "LOCKED"`.
   - The Gateway enforces fail-closed rejection: all L1, L2, and L3 tool requests are unconditionally denied (`403 Forbidden`).

2. **Wake-Phrase Detection While Locked:**
   - **Default Behavior:** The acoustic wake engine (`WakePhraseEngine.cs`) is suspended. The microphone does not process speech.
   - **Zero Power & Privacy Invariant:** No audio buffers are recorded, transcribed, or forwarded to the Gateway while locked.

3. **Session Unlock Event (`WTS_SESSION_UNLOCK`):**
   - Upon successful Windows authentication, the companion transitions state back to `SESSION_UNLOCKED`.
   - The Gateway Policy Engine marks the session `UNLOCKED`.
   - The wake engine re-arms listening, and the system tray icon returns to active green.

### 4.2 Permitted Optional Extension: Restricted Lock-State Chime
If the user explicitly enables `AllowLockScreenAnnouncement` in configuration, the ONLY permitted response to a wake trigger is:
- **Visual:** None (orb remains hidden).
- **Tool Access:** None (zero tools dispatched).
- **Inference:** None (Ollama / LLM is bypassed).
- **Spoken Audio:** A fixed, canned announcement synthesized via local TTS or audio chime:
  > *"Workstation is locked. Please unlock Windows to access NEXUS."*
- After speaking this single notice, the companion immediately returns to dormant silence.

---

## 5. Preservation of Native Windows Authentication (Prohibition of Custom Credential Providers & Auto-Unlock)

In strict accordance with the Principal Security Architect directives:

1. **No Custom Credential Providers:**
   - Under the Windows Security Architecture, a Windows Credential Provider (`ICredentialProvider` / `ICredentialProviderCredential2`) is merely a UI serialization filter that gathers user credentials and packages them for submission to LSASS. It is **not** an authentication authority.
   - Project NEXUS shall **never** install a custom Windows Credential Provider into `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers`.
2. **No Password Stash or Credential Replay:**
   - NEXUS shall **never** ask for, collect, encrypt, or store the user's Windows account password or PIN, and shall **never** attempt to simulate keyboard sign-in keystrokes (`SendInput`, `PostMessage`) across the desktop boundary to unlock the workstation.
3. **No Insecure RGB Webcam / Voice Biometric Bypasses:**
   - Standard RGB webcams (such as `OMEN Cam & Voice`) lack hardware Infrared (IR) structured light and depth sensing, making them inherently vulnerable to 2D photo and screen replay attacks.
   - Pure acoustic voiceprints are vulnerable to replay attacks and generative AI voice cloning.
   - Therefore, software-only RGB face matching or voice unlocking is **formally prohibited** from acting as a Windows logon or unlock authority.
4. **Mandated Standard — Windows Hello:**
   - The only supported biometric authentication mechanism is native **Windows Hello** (utilizing Microsoft-certified hardware IR depth cameras or hardware fingerprint readers evaluated by the Windows Biometric Framework and isolated in VBS/LSASS).
   - If Windows Settings reports that facial recognition is unavailable due to hardware absence, the user must authenticate using their standard Windows PIN, password, or certified Windows Hello fingerprint reader.
5. **Locked-Session Invariant:**
   - The system strictly enforces the locked-session restriction: whenever the workstation is locked (`WTS_SESSION_LOCK`), all microphone audio capture is disarmed, speech playback is halted, the floating orb is hidden, and all L1–L3 protected operations fail closed (`403 Forbidden`).

---

## 6. Security Certification Sign-Off

The security architecture of Project NEXUS V2.3 is certified compliant with this policy:
- **Gateway Policy Engine (`policy.ts`):** Verified 100% fail-closed against `LOCKED` and `UNKNOWN` sessions.
- **Session Sentinel (`NexusDesktopCompanion.cs`):** Verified registering for and responding to `WTSRegisterSessionNotification`.
- **Test Suite Verification:** Confirmed by [`tests/test_session_sentinel_phase2.mjs`](file:///c:/MSC/my-desk/ai-personal-assistants/tests/test_session_sentinel_phase2.mjs) and [`tests/test_gateway_security_policy.mjs`](file:///c:/MSC/my-desk/ai-personal-assistants/tests/test_gateway_security_policy.mjs).

**Principal Security Architect Sign-Off:** ✅ **APPROVED & FROZEN**
