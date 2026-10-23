using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using System.Collections.Generic;
using Nexus.DesktopCompanion.Audio;

namespace Nexus.DesktopCompanion
{
    public static class Program
    {
        private const string MutexName = "Local\\NEXUS_DESKTOP_COMPANION_MUTEX";

        [STAThread]
        public static void Main(string[] args)
        {
            int port = 3005;
            int gatewayPort = 3000;
            bool backgroundMode = false;
            string cliAction = null;

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i].ToLowerInvariant();
                if (arg == "--port" && i + 1 < args.Length)
                {
                    int.TryParse(args[++i], out port);
                }
                else if (arg == "--gateway-port" && i + 1 < args.Length)
                {
                    int.TryParse(args[++i], out gatewayPort);
                }
                else if (arg == "--background" || arg == "-b")
                {
                    backgroundMode = true;
                }
                else if (arg == "--status" || arg == "--simulate-lock" || arg == "--simulate-unlock" ||
                         arg == "--simulate-wake" || arg == "--exit" || arg == "--mute" ||
                         arg == "--orb-show" || arg == "--orb-hide" || arg == "--startup-toggle")
                {
                    cliAction = arg;
                }
            }

            // CLI execution path (communicate with running instance)
            if (!string.IsNullOrEmpty(cliAction))
            {
                ExecuteCliAction(cliAction, port);
                return;
            }

            try
            {
                bool createdNew;
                using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
                {
                    if (!createdNew)
                    {
                        Console.WriteLine("NexusDesktopCompanion is already running in background.");
                        return;
                    }

                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);

                    CompanionContext context = new CompanionContext(port, gatewayPort, backgroundMode);
                    Application.Run(context);
                    File.AppendAllText("C:\\MSC\\my-desk\\ai-personal-assistants\\apps\\desktop-companion\\crash.log", "\nApplication.Run ended");
                }
            }
            catch (Exception ex)
            {
                try
                {
                    File.AppendAllText("C:\\MSC\\my-desk\\ai-personal-assistants\\apps\\desktop-companion\\crash.log", "\nException: " + ex.ToString());
                }
                catch { }
            }
        }

        private static void ExecuteCliAction(string action, int port)
        {
            string url = string.Format("http://127.0.0.1:{0}/", port);
            try
            {
                if (action == "--status")
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url + "status");
                    req.Method = "GET";
                    req.Timeout = 3000;
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    {
                        Console.WriteLine(reader.ReadToEnd());
                    }
                }
                else
                {
                    string endpoint = action.Replace("--", "").Replace("-", "/");
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url + endpoint);
                    req.Method = "POST";
                    req.ContentLength = 0;
                    req.Timeout = 3000;
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    {
                        Console.WriteLine(reader.ReadToEnd());
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[ERROR] Failed to communicate with companion: " + ex.Message);
                Environment.Exit(1);
            }
        }
    }

    public class CompanionContext : ApplicationContext
    {
        private const string RegistryRunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string AppRegistryName = "NEXUS_Desktop_Companion";

        private readonly int _ipcPort;
        private readonly int _gatewayPort;
        private readonly NotifyIcon _trayIcon;
        private readonly ContextMenuStrip _contextMenu;
        private readonly ToolStripMenuItem _statusItem;
        private readonly ToolStripMenuItem _devicesMenu;
        private readonly ToolStripMenuItem _muteItem;
        private readonly ToolStripMenuItem _startupItem;
        private readonly ToolStripMenuItem _hotkeyItem;

        private readonly SessionMessageWindow _messageWindow;
        private readonly OrbForm _orbWindow;

        private HttpListener _httpListener;
        private Thread _httpThread;
        private volatile bool _isRunning = true;

        private string _sessionState = "UNLOCKED";
        private bool _isMuted = false;
        private string _displayState = "ON";
        private volatile string _orbState = "IDLE";
        private System.Threading.Timer _heartbeatTimer;
        private long _lastGatewaySyncTicks = 0;
        private readonly NativeAudioEngine _audioEngine;
        private readonly WakePhraseEngine _wakeEngine;
        private readonly LocalSttEngine _sttEngine;
        private readonly LocalTtsEngine _ttsEngine;

        public CompanionContext(int ipcPort, int gatewayPort, bool backgroundMode)
        {
            _ipcPort = ipcPort;
            _gatewayPort = gatewayPort;

            // 1. Create Native Floating Orb Window (Hidden initially)
            _orbWindow = new OrbForm(this);

            // 1b. Initialize Native Audio Subsystem
            _audioEngine = new NativeAudioEngine();

            // 1c. Initialize Local Wake-Phrase Engine ("Hey NEXUS")
            _wakeEngine = new WakePhraseEngine();

            // 1d. Initialize Local Speech-to-Text Engine
            _sttEngine = new LocalSttEngine();

            // 1e. Initialize Local Text-to-Speech Engine
            _ttsEngine = new LocalTtsEngine();
            _ttsEngine.OnSpeechStarted += () =>
            {
                Console.WriteLine("[EVENT] TTS speech started -> Orb state SPEAKING");
                ShowOrb("SPEAKING");
                if (_wakeEngine != null) _wakeEngine.SetAssistantSpeaking(true);
            };
            _ttsEngine.OnSpeechCompleted += (wasCancelled) =>
            {
                Console.WriteLine("[EVENT] TTS speech completed (Cancelled: " + wasCancelled + ")");
                if (_wakeEngine != null) _wakeEngine.SetAssistantSpeaking(false);
                if (!wasCancelled)
                {
                    ShowOrb("IDLE");
                }
            };
            _ttsEngine.OnSpeechAudioLevel += (level) =>
            {
                if (_orbWindow != null && !_orbWindow.IsDisposed)
                {
                    _orbWindow.UpdateAudioLevel(level);
                }
            };
            _ttsEngine.OnBargeInOccurred += (reason, latencyMs) =>
            {
                Console.WriteLine(string.Format("[EVENT] Barge-in occurred ({0}) in {1:0.0}ms -> Orb state INTERRUPTED", reason, latencyMs));
                ShowOrb("INTERRUPTED");
            };

            _sttEngine.OnEndOfUtteranceDetected += () =>
            {
                Console.WriteLine("[EVENT] End of utterance detected -> Transitioning to PROCESSING");
                ShowOrb("PROCESSING");
            };
            _sttEngine.OnTranscriptionCompleted += (result) =>
            {
                if (result.IsSuccess)
                {
                    Console.WriteLine(string.Format("[STT-TRANSCRIPTION] '{0}' (Confidence: {1:0.00}, Duration: {2}ms)", result.Text, result.Confidence, result.DurationMs));
                    string lower = result.Text.Trim().ToLowerInvariant();
                    if (lower == "mute" || lower == "mute microphone" || lower == "mute mic" || lower == "nexus mute" || lower == "nexus, mute")
                    {
                        Console.WriteLine("[VOICE-CMD] Microphone mute triggered by voice.");
                        ToggleMute();
                        return;
                    }
                    if (lower == "stop" || lower == "pause" || lower == "cancel" || lower == "quiet" || lower == "nexus stop" || lower == "nexus, stop" || lower == "nexus pause" || lower == "nexus, pause")
                    {
                        Console.WriteLine("[VOICE-CMD] Stop/Pause triggered by voice.");
                        if (_ttsEngine != null) _ttsEngine.CancelSpeech("voice-stop-command");
                        HideOrb();
                        return;
                    }

                    ThreadPool.QueueUserWorkItem(_ => DispatchVoicePromptToGateway(result.Text, "voice-session-default"));
                }
                else
                {
                    Console.WriteLine("[STT-FAIL] " + result.ErrorMessage);
                    ShowOrb("IDLE");
                }
            };

            _wakeEngine.OnWakeDetected += (result) =>
            {
                Console.WriteLine(string.Format("[EVENT] Assistant activated by {0}: {1}", result.Source, result.Phrase));
                if (_ttsEngine != null && _ttsEngine.IsSpeaking)
                {
                    _ttsEngine.CancelSpeech("wake-phrase");
                }
                ShowOrb("LISTENING");
                if (_sttEngine != null)
                {
                    _sttEngine.StartUtteranceRecording();
                }
            };

            // Connect audio stream chunks to Orb pulse, Wake-Phrase Engine, and STT Utterance Recorder
            _audioEngine.OnAudioChunkAvailable += (bytes, rms) =>
            {
                if (_orbWindow != null && !_orbWindow.IsDisposed)
                {
                    _orbWindow.UpdateAudioLevel(rms);
                }
                if (_wakeEngine != null)
                {
                    _wakeEngine.FeedPcmChunk(bytes, rms);
                }
                if (_sttEngine != null && _sttEngine.IsRecordingUtterance)
                {
                    _sttEngine.ProcessAudioChunkForEou(bytes, rms);
                }
            };
            _audioEngine.StartCapture();

            // 2. Create System Tray Context Menu
            _contextMenu = new ContextMenuStrip();

            ToolStripMenuItem titleItem = new ToolStripMenuItem("NEXUS Assistant v2.3");
            titleItem.Enabled = false;
            titleItem.Font = new Font(titleItem.Font, FontStyle.Bold);
            _contextMenu.Items.Add(titleItem);

            _statusItem = new ToolStripMenuItem("● Status: Standby (Unlocked)");
            _statusItem.Enabled = false;
            _contextMenu.Items.Add(_statusItem);

            _devicesMenu = new ToolStripMenuItem("Microphone Device");
            RefreshDevicesMenu();
            _contextMenu.Items.Add(_devicesMenu);

            _contextMenu.Items.Add(new ToolStripSeparator());

            _muteItem = new ToolStripMenuItem("Mute Microphone", null, OnToggleMute);
            _muteItem.Checked = _isMuted;
            _contextMenu.Items.Add(_muteItem);

            _startupItem = new ToolStripMenuItem("Start with Windows", null, OnToggleStartup);
            _startupItem.Checked = IsStartupEnabled();
            _contextMenu.Items.Add(_startupItem);

            _hotkeyItem = new ToolStripMenuItem("Activate Assistant", null, (s, e) => OnActivateHotkey());
            _contextMenu.Items.Add(_hotkeyItem);

            ToolStripMenuItem toggleOrbItem = new ToolStripMenuItem("Toggle Floating Orb", null, (s, e) => ToggleOrbVisibility());
            _contextMenu.Items.Add(toggleOrbItem);

            _contextMenu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem exitItem = new ToolStripMenuItem("Exit NEXUS", null, (s, e) => ExitApplication());
            _contextMenu.Items.Add(exitItem);

            // 3. Create Tray Icon
            _trayIcon = new NotifyIcon
            {
                Text = "Project NEXUS — Standby (Unlocked)",
                Icon = GenerateOrbIcon(Color.FromArgb(0, 210, 255), Color.FromArgb(99, 102, 241)),
                ContextMenuStrip = _contextMenu,
                Visible = true
            };
            _trayIcon.DoubleClick += (s, e) => ToggleOrbVisibility();

            // 4. Initialize Win32 Message Window
            _messageWindow = new SessionMessageWindow(this);
            _hotkeyItem.Text = string.Format("Activate Assistant ({0})", _messageWindow.ActiveHotkey);

            // 5. Start Local Loopback IPC Server
            StartIpcServer();

            // 6. Notify Gateway of Initial Session State
            NotifyGatewaySessionState(_sessionState);

            // 7. Start Heartbeat Timer to Gateway
            _heartbeatTimer = new System.Threading.Timer(OnHeartbeatTick, null, 1000, 2500);

            _trayIcon.ShowBalloonTip(3000, "NEXUS Voice-First Assistant",
                string.Format("NEXUS is online. Say 'Hey NEXUS' or press {0} to activate.", _messageWindow.ActiveHotkey),
                ToolTipIcon.Info);
        }

        private void RefreshDevicesMenu()
        {
            if (_devicesMenu == null || _audioEngine == null) return;
            try
            {
                _devicesMenu.DropDownItems.Clear();
                var devices = _audioEngine.GetInputDevices();
                foreach (var dev in devices)
                {
                    ToolStripMenuItem dItem = new ToolStripMenuItem(dev.Name);
                    dItem.Checked = (dev.DeviceId == _audioEngine.ActiveDeviceId || (_audioEngine.ActiveDeviceId == -1 && dev.DeviceId == 0));
                    int targetId = dev.DeviceId;
                    string targetName = dev.Name;
                    dItem.Click += (s, e) =>
                    {
                        _audioEngine.StartCapture(targetId);
                        RefreshDevicesMenu();
                        Console.WriteLine("[AUDIO] Switched input device to ID " + targetId + ": " + targetName);
                    };
                    _devicesMenu.DropDownItems.Add(dItem);
                }
            }
            catch { }
        }

        #region Session and Power Events
        public void HandleSessionLock()
        {
            _sessionState = "LOCKED";
            if (_audioEngine != null) _audioEngine.SetSessionState("LOCKED");
            if (_wakeEngine != null) _wakeEngine.SetSessionState("LOCKED");
            if (_sttEngine != null) _sttEngine.CancelUtterance();
            UpdateTrayState();
            HideOrb();
            NotifyGatewaySessionState("LOCKED");
            Console.WriteLine("[EVENT] Windows Session LOCKED -> Disarmed audio and hid orb.");
        }

        public void HandleSessionUnlock()
        {
            _sessionState = "UNLOCKED";
            if (_audioEngine != null) _audioEngine.SetSessionState("UNLOCKED");
            if (_wakeEngine != null) _wakeEngine.SetSessionState("UNLOCKED");
            UpdateTrayState();
            NotifyGatewaySessionState("UNLOCKED");
            Console.WriteLine("[EVENT] Windows Session UNLOCKED -> Restored Standby state.");
        }

        public void HandleDisplayStateChange(int state)
        {
            if (state == 0)
            {
                _displayState = "OFF";
                HideOrb();
                Console.WriteLine("[EVENT] Display turned OFF (blanked).");
            }
            else
            {
                _displayState = "ON";
                Console.WriteLine("[EVENT] Display turned ON (screen wake). Note: Session remains " + _sessionState + ".");
            }
        }

        public void HandleHotkey()
        {
            if (_sessionState == "LOCKED" || _sessionState == "UNKNOWN")
            {
                Console.WriteLine("[BLOCKED] Activation hotkey rejected: Workstation is " + _sessionState);
                return;
            }

            if (_isMuted)
            {
                Console.WriteLine("[HOTKEY] Assistant was muted. Physical hotkey pressed -> Unmuting microphone.");
                ToggleMute();
            }

            if (_ttsEngine != null && _ttsEngine.IsSpeaking)
            {
                _ttsEngine.CancelSpeech("hotkey-barge-in");
            }

            Console.WriteLine(string.Format("[TRIGGER] {0} global hotkey activated NEXUS assistant.", _messageWindow.ActiveHotkey));
            if (_wakeEngine != null)
            {
                _wakeEngine.TriggerHotkey();
            }
            else
            {
                ShowOrb("LISTENING");
            }
        }
        #endregion

        #region Orb Window Control
        public void ShowOrb(string state = "LISTENING")
        {
            if (_sessionState == "LOCKED")
            {
                Console.WriteLine("[BLOCKED] Cannot show orb: Workstation is locked.");
                return;
            }

            if (state == "SPEAKING")
            {
                if (_wakeEngine != null) _wakeEngine.SetAssistantSpeaking(true);
            }
            else
            {
                if (_wakeEngine != null) _wakeEngine.SetAssistantSpeaking(false);
            }

            _orbState = state;
            if (_orbWindow != null && !_orbWindow.IsDisposed)
            {
                try
                {
                    if (_orbWindow.InvokeRequired)
                    {
                        _orbWindow.BeginInvoke(new Action(() => _orbWindow.SetStateAndShow(state)));
                    }
                    else
                    {
                        _orbWindow.SetStateAndShow(state);
                    }
                }
                catch { }
            }
        }

        public void HideOrb()
        {
            _orbState = "IDLE";
            if (_wakeEngine != null) _wakeEngine.SetAssistantSpeaking(false);
            if (_orbWindow != null && !_orbWindow.IsDisposed)
            {
                try
                {
                    if (_orbWindow.InvokeRequired)
                    {
                        _orbWindow.BeginInvoke(new Action(() => _orbWindow.HideOrb()));
                    }
                    else
                    {
                        _orbWindow.HideOrb();
                    }
                }
                catch { }
            }
        }

        public void ToggleOrbVisibility()
        {
            if (_orbState != "IDLE")
            {
                HideOrb();
            }
            else
            {
                ShowOrb("LISTENING");
            }
        }

        public bool IsOrbVisible
        {
            get { return _orbState != "IDLE"; }
        }

        public string CurrentOrbState
        {
            get { return _orbState; }
        }
        #endregion

        #region Tray and UI Updates
        private void UpdateTrayState()
        {
            if (_sessionState == "LOCKED")
            {
                _statusItem.Text = "■ Status: Disarmed (Locked)";
                _trayIcon.Text = "Project NEXUS — Disarmed (Locked)";
                _trayIcon.Icon = GenerateOrbIcon(Color.FromArgb(239, 68, 68), Color.FromArgb(185, 28, 28));
                _muteItem.Text = "Mute Microphone";
                _muteItem.Enabled = false;
            }
            else if (_isMuted)
            {
                _statusItem.Text = "○ Status: Muted (Standby)";
                _trayIcon.Text = "Project NEXUS — Microphone Muted";
                _trayIcon.Icon = GenerateOrbIcon(Color.FromArgb(245, 158, 11), Color.FromArgb(217, 119, 6));
                _muteItem.Text = "Unmute Microphone (Ctrl+Alt+M)";
                _muteItem.Checked = true;
                _muteItem.Enabled = true;
            }
            else
            {
                _statusItem.Text = "● Status: Standby (Unlocked)";
                _trayIcon.Text = "Project NEXUS — Standby (Unlocked)";
                _trayIcon.Icon = GenerateOrbIcon(Color.FromArgb(0, 210, 255), Color.FromArgb(99, 102, 241));
                _muteItem.Text = "Mute Microphone (Ctrl+Alt+M)";
                _muteItem.Checked = false;
                _muteItem.Enabled = true;
            }
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        private Icon GenerateOrbIcon(Color color1, Color color2)
        {
            using (Bitmap bmp = new Bitmap(16, 16))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (SolidBrush bg = new SolidBrush(Color.FromArgb(15, 23, 42)))
                {
                    g.FillEllipse(bg, 0, 0, 15, 15);
                }
                using (LinearGradientBrush brush = new LinearGradientBrush(new Rectangle(1, 1, 14, 14), color1, color2, 45f))
                {
                    g.FillEllipse(brush, 1, 1, 13, 13);
                }
                using (Pen pen = new Pen(Color.White, 1f))
                {
                    g.DrawEllipse(pen, 1, 1, 13, 13);
                }
                IntPtr hIcon = bmp.GetHicon();
                Icon managedIcon = (Icon)Icon.FromHandle(hIcon).Clone();
                DestroyIcon(hIcon);
                return managedIcon;
            }
        }

        public void ToggleMute()
        {
            _isMuted = !_isMuted;
            if (_audioEngine != null) _audioEngine.SetMute(_isMuted);
            if (_wakeEngine != null) _wakeEngine.SetMuted(_isMuted);
            _muteItem.Checked = _isMuted;
            if (_isMuted)
            {
                HideOrb();
            }
            UpdateTrayState();
            Console.WriteLine("[PRIVACY] Microphone mute status toggled to: " + _isMuted);
        }

        private void OnToggleMute(object sender, EventArgs e)
        {
            ToggleMute();
        }

        private void OnActivateHotkey()
        {
            HandleHotkey();
        }

        private void OnToggleStartup(object sender, EventArgs e)
        {
            bool current = IsStartupEnabled();
            SetStartupEnabled(!current);
            _startupItem.Checked = !current;
        }
        #endregion

        #region Windows Startup Management
        public bool IsStartupEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryRunKey, false))
                {
                    if (key != null)
                    {
                        object val = key.GetValue(AppRegistryName);
                        return val != null;
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[WARN] Failed to read startup registry key: " + ex.Message);
            }
            return false;
        }

        public void SetStartupEnabled(bool enable)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryRunKey, true))
                {
                    if (key != null)
                    {
                        if (enable)
                        {
                            string exePath = Assembly.GetExecutingAssembly().Location;
                            string runCmd = string.Format("\"{0}\" --background", exePath);
                            key.SetValue(AppRegistryName, runCmd);
                            Console.WriteLine("[CONFIG] Windows startup registered: " + runCmd);
                        }
                        else
                        {
                            key.DeleteValue(AppRegistryName, false);
                            Console.WriteLine("[CONFIG] Windows startup unregistered.");
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[ERROR] Failed to write startup registry key: " + ex.Message);
            }
        }
        #endregion

        #region Gateway IPC Notification & Heartbeat
        private void NotifyGatewaySessionState(string state)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                // Send to primary sentinel endpoint
                try
                {
                    string url = string.Format("http://127.0.0.1:{0}/api/session/state", _gatewayPort);
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    req.Timeout = 1500;

                    string payload = string.Format("{{\"state\":\"{0}\"}}", state);
                    byte[] bytes = Encoding.UTF8.GetBytes(payload);
                    req.ContentLength = bytes.Length;

                    using (Stream stream = req.GetRequestStream())
                    {
                        stream.Write(bytes, 0, bytes.Length);
                    }

                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        _lastGatewaySyncTicks = DateTime.UtcNow.Ticks;
                    }
                }
                catch { }

                // Also send to test harness endpoint for backward compatibility
                try
                {
                    string testUrl = string.Format("http://127.0.0.1:{0}/api/test/session-state", _gatewayPort);
                    HttpWebRequest testReq = (HttpWebRequest)WebRequest.Create(testUrl);
                    testReq.Method = "POST";
                    testReq.ContentType = "application/json";
                    testReq.Timeout = 1500;

                    string testPayload = string.Format("{{\"state\":\"{0}\"}}", state);
                    byte[] testBytes = Encoding.UTF8.GetBytes(testPayload);
                    testReq.ContentLength = testBytes.Length;

                    using (Stream stream = testReq.GetRequestStream())
                    {
                        stream.Write(testBytes, 0, testBytes.Length);
                    }

                    using (HttpWebResponse resp = (HttpWebResponse)testReq.GetResponse()) { }
                }
                catch { }
            });
        }

        private void OnHeartbeatTick(object state)
        {
            if (!_isRunning) return;
            SendGatewayHeartbeat();
        }

        public void SendGatewayHeartbeat()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    string url = string.Format("http://127.0.0.1:{0}/api/session/heartbeat", _gatewayPort);
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    req.Timeout = 1500;

                    string payload = string.Format("{{\"state\":\"{0}\"}}", _sessionState);
                    byte[] bytes = Encoding.UTF8.GetBytes(payload);
                    req.ContentLength = bytes.Length;

                    using (Stream stream = req.GetRequestStream())
                    {
                        stream.Write(bytes, 0, bytes.Length);
                    }

                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        _lastGatewaySyncTicks = DateTime.UtcNow.Ticks;
                    }
                }
                catch
                {
                    // Non-fatal if gateway is temporarily starting
                }
            });
        }
        #endregion

        #region Local HTTP IPC Server
        private void StartIpcServer()
        {
            try
            {
                _httpListener = new HttpListener();
                string prefix = string.Format("http://127.0.0.1:{0}/", _ipcPort);
                _httpListener.Prefixes.Add(prefix);
                _httpListener.Start();

                _httpThread = new Thread(ListenIpcLoop) { IsBackground = true };
                _httpThread.Start();
                Console.WriteLine("[IPC] Local companion IPC server online at " + prefix);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[WARN] Failed to start local IPC server: " + ex.Message);
            }
        }

        private void ListenIpcLoop()
        {
            while (_isRunning && _httpListener != null && _httpListener.IsListening)
            {
                try
                {
                    HttpListenerContext context = _httpListener.GetContext();
                    ThreadPool.QueueUserWorkItem(ProcessIpcRequest, context);
                }
                catch
                {
                    if (!_isRunning) break;
                }
            }
        }

        private void ProcessIpcRequest(object state)
        {
            HttpListenerContext context = (HttpListenerContext)state;
            HttpListenerRequest req = context.Request;
            HttpListenerResponse resp = context.Response;

            resp.ContentType = "application/json";
            resp.Headers.Add("Access-Control-Allow-Origin", "*");

            try
            {
                string path = req.Url.AbsolutePath.ToLowerInvariant();
                string responseJson = "{}";

                if (path == "/status" && req.HttpMethod == "GET")
                {
                    responseJson = string.Format(
                        "{{\"status\":\"ok\",\"service\":\"nexus-desktop-companion\",\"sessionState\":\"{0}\",\"isMuted\":{1},\"startupEnabled\":{2},\"hotkeyRegistered\":{3},\"activeHotkey\":\"{4}\",\"displayState\":\"{5}\",\"orbVisible\":{6},\"orbState\":\"{7}\"}}",
                        _sessionState,
                        _isMuted.ToString().ToLowerInvariant(),
                        IsStartupEnabled().ToString().ToLowerInvariant(),
                        _messageWindow.IsHotkeyRegistered.ToString().ToLowerInvariant(),
                        _messageWindow.ActiveHotkey,
                        _displayState,
                        IsOrbVisible.ToString().ToLowerInvariant(),
                        CurrentOrbState
                    );
                }
                else if (path == "/mute" && req.HttpMethod == "POST")
                {
                    ToggleMute();
                    responseJson = string.Format("{{\"isMuted\":{0}}}", _isMuted.ToString().ToLowerInvariant());
                }
                else if (path == "/orb/show" && req.HttpMethod == "POST")
                {
                    ShowOrb("LISTENING");
                    responseJson = string.Format("{{\"orbVisible\":true,\"orbState\":\"{0}\"}}", CurrentOrbState);
                }
                else if (path == "/orb/hide" && req.HttpMethod == "POST")
                {
                    HideOrb();
                    responseJson = "{\"orbVisible\":false,\"orbState\":\"IDLE\"}";
                }
                else if (path == "/orb/status" && req.HttpMethod == "GET")
                {
                    Point loc = (_orbWindow != null && !_orbWindow.IsDisposed) ? _orbWindow.CurrentPosition : new Point(0, 0);
                    Size sz = (_orbWindow != null && !_orbWindow.IsDisposed) ? _orbWindow.Size : new Size(0, 0);
                    float aLevel = (_orbWindow != null && !_orbWindow.IsDisposed) ? _orbWindow.AudioLevel : 0f;
                    int timeout = (_orbWindow != null && !_orbWindow.IsDisposed) ? _orbWindow.AutoHideTimeoutMs : 3000;
                    bool isPresentation = OrbForm.IsFullscreenOrPresentationMode();

                    responseJson = string.Format(
                        "{{\"state\":\"{0}\",\"orbVisible\":{1},\"sessionState\":\"{2}\",\"gatewayPort\":{3},\"x\":{4},\"y\":{5},\"width\":{6},\"height\":{7},\"audioLevel\":{8:0.000},\"isPresentationMode\":{9},\"autoHideTimeoutMs\":{10},\"styles\":{{\"wsLayered\":true,\"wsNoActivate\":true,\"wsToolWindow\":true,\"wsTopMost\":true}}}}",
                        CurrentOrbState,
                        IsOrbVisible.ToString().ToLowerInvariant(),
                        _sessionState,
                        _gatewayPort,
                        loc.X,
                        loc.Y,
                        sz.Width,
                        sz.Height,
                        aLevel,
                        isPresentation.ToString().ToLowerInvariant(),
                        timeout
                    );
                }
                else if (path == "/orb/state" && req.HttpMethod == "POST")
                {
                    string[] validStates = new string[] { "IDLE", "LISTENING", "PROCESSING", "SPEAKING", "INTERRUPTED", "AUTH_REQUIRED", "MUTED", "LOCKED", "ERROR" };
                    string targetState = "LISTENING";
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd().ToUpperInvariant();
                        foreach (string s in validStates)
                        {
                            if (body.Contains(s))
                            {
                                targetState = s;
                                break;
                            }
                        }
                    }

                    if (targetState == "IDLE")
                    {
                        HideOrb();
                    }
                    else
                    {
                        ShowOrb(targetState);
                    }
                    responseJson = string.Format("{{\"orbVisible\":{0},\"orbState\":\"{1}\"}}", IsOrbVisible.ToString().ToLowerInvariant(), CurrentOrbState);
                }
                else if (path == "/orb/audio-level" && req.HttpMethod == "POST")
                {
                    float level = 0f;
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd();
                        System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"[-+]?[0-9]*\.?[0-9]+");
                        if (m.Success) float.TryParse(m.Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out level);
                    }
                    if (_orbWindow != null && !_orbWindow.IsDisposed)
                    {
                        _orbWindow.UpdateAudioLevel(level);
                    }
                    responseJson = string.Format("{{\"audioLevel\":{0:0.000}}}", level);
                }
                else if (path == "/orb/position" && req.HttpMethod == "POST")
                {
                    int posX = 0, posY = 0;
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd();
                        System.Text.RegularExpressions.Match mx = System.Text.RegularExpressions.Regex.Match(body, @"""x""\s*:\s*(\d+)");
                        System.Text.RegularExpressions.Match my = System.Text.RegularExpressions.Regex.Match(body, @"""y""\s*:\s*(\d+)");
                        if (mx.Success) int.TryParse(mx.Groups[1].Value, out posX);
                        if (my.Success) int.TryParse(my.Groups[1].Value, out posY);
                    }
                    if (_orbWindow != null && !_orbWindow.IsDisposed)
                    {
                        _orbWindow.CurrentPosition = new Point(posX, posY);
                    }
                    responseJson = string.Format("{{\"x\":{0},\"y\":{1}}}", posX, posY);
                }
                else if (path == "/orb/auto-hide" && req.HttpMethod == "POST")
                {
                    int timeout = 500;
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd();
                        System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""timeoutMs""\s*:\s*(\d+)");
                        if (m.Success) int.TryParse(m.Groups[1].Value, out timeout);
                    }
                    if (_orbWindow != null && !_orbWindow.IsDisposed)
                    {
                        _orbWindow.AutoHideTimeoutMs = timeout;
                    }
                    responseJson = string.Format("{{\"autoHideTimeoutMs\":{0}}}", timeout);
                }
                else if (path == "/startup/toggle" && req.HttpMethod == "POST")
                {
                    bool current = IsStartupEnabled();
                    SetStartupEnabled(!current);
                    _startupItem.Checked = !current;
                    responseJson = string.Format("{{\"startupEnabled\":{0}}}", (!current).ToString().ToLowerInvariant());
                }
                else if (path == "/simulate-lock" && req.HttpMethod == "POST")
                {
                    HandleSessionLock();
                    responseJson = "{\"sessionState\":\"LOCKED\"}";
                }
                else if (path == "/simulate-unlock" && req.HttpMethod == "POST")
                {
                    HandleSessionUnlock();
                    responseJson = "{\"sessionState\":\"UNLOCKED\"}";
                }
                else if (path == "/simulate-wake" && req.HttpMethod == "POST")
                {
                    HandleDisplayStateChange(1);
                    responseJson = string.Format("{{\"sessionState\":\"{0}\",\"displayState\":\"ON\"}}", _sessionState);
                }
                else if (path == "/sentinel/status" && req.HttpMethod == "GET")
                {
                    long ageMs = (_lastGatewaySyncTicks > 0) ? (long)(TimeSpan.FromTicks(DateTime.UtcNow.Ticks - _lastGatewaySyncTicks).TotalMilliseconds) : -1;
                    responseJson = string.Format(
                        "{{\"sessionState\":\"{0}\",\"displayState\":\"{1}\",\"isMuted\":{2},\"lastGatewaySyncAgeMs\":{3}}}",
                        _sessionState, _displayState, _isMuted.ToString().ToLowerInvariant(), ageMs);
                }
                else if (path == "/sentinel/heartbeat" && req.HttpMethod == "POST")
                {
                    SendGatewayHeartbeat();
                    responseJson = "{\"status\":\"heartbeat_dispatched\"}";
                }
                else if (path == "/audio/devices" && req.HttpMethod == "GET")
                {
                    List<AudioDeviceInfo> inputs = _audioEngine.GetInputDevices();
                    List<AudioDeviceInfo> outputs = _audioEngine.GetOutputDevices();

                    StringBuilder sb = new StringBuilder();
                    sb.Append("{\"inputDevices\":[");
                    for (int i = 0; i < inputs.Count; i++)
                    {
                        if (i > 0) sb.Append(",");
                        sb.Append(string.Format("{{\"id\":{0},\"name\":\"{1}\",\"channels\":{2},\"isDefault\":{3}}}",
                            inputs[i].DeviceId, EscapeJson(inputs[i].Name), inputs[i].Channels, inputs[i].IsDefault.ToString().ToLowerInvariant()));
                    }
                    sb.Append("],\"outputDevices\":[");
                    for (int i = 0; i < outputs.Count; i++)
                    {
                        if (i > 0) sb.Append(",");
                        sb.Append(string.Format("{{\"id\":{0},\"name\":\"{1}\",\"channels\":{2},\"isDefault\":{3}}}",
                            outputs[i].DeviceId, EscapeJson(outputs[i].Name), outputs[i].Channels, outputs[i].IsDefault.ToString().ToLowerInvariant()));
                    }
                    sb.Append("]}");
                    responseJson = sb.ToString();
                }
                else if (path == "/audio/status" && req.HttpMethod == "GET")
                {
                    responseJson = string.Format(
                        "{{\"isCapturing\":{0},\"isMuted\":{1},\"sessionState\":\"{2}\",\"sampleRate\":{3},\"channels\":{4},\"bitsPerSample\":{5},\"rms\":{6:0.0000},\"peak\":{7:0.0000},\"deviceId\":{8}}}",
                        _audioEngine.IsCapturing.ToString().ToLowerInvariant(),
                        _audioEngine.IsMuted.ToString().ToLowerInvariant(),
                        _sessionState,
                        _audioEngine.SampleRate,
                        _audioEngine.Channels,
                        _audioEngine.BitsPerSample,
                        _audioEngine.CurrentRms,
                        _audioEngine.PeakLevel,
                        _audioEngine.ActiveDeviceId
                    );
                }
                else if (path == "/audio/mute" && req.HttpMethod == "POST")
                {
                    ToggleMute();
                    responseJson = string.Format("{{\"isMuted\":{0}}}", _isMuted.ToString().ToLowerInvariant());
                }
                else if (path == "/audio/inject" && req.HttpMethod == "POST")
                {
                    int freq = 440;
                    int duration = 250;
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd();
                        if (body.Contains("frequency"))
                        {
                            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""frequency""\s*:\s*(\d+)");
                            if (m.Success) int.TryParse(m.Groups[1].Value, out freq);
                        }
                        if (body.Contains("durationMs"))
                        {
                            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""durationMs""\s*:\s*(\d+)");
                            if (m.Success) int.TryParse(m.Groups[1].Value, out duration);
                        }
                    }

                    _audioEngine.InjectTestTone(freq, duration);
                    responseJson = string.Format("{{\"injected\":true,\"frequency\":{0},\"durationMs\":{1},\"rms\":{2:0.0000}}}",
                        freq, duration, _audioEngine.CurrentRms);
                }
                else if ((path == "/audio/start" || path == "/audio/device") && req.HttpMethod == "POST")
                {
                    int devId = _audioEngine.ActiveDeviceId;
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd();
                        System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""deviceId""\s*:\s*(-?\d+)");
                        if (m.Success) int.TryParse(m.Groups[1].Value, out devId);
                    }

                    bool ok = _audioEngine.StartCapture(devId);
                    RefreshDevicesMenu();
                    responseJson = string.Format("{{\"started\":{0},\"deviceId\":{1}}}", ok.ToString().ToLowerInvariant(), devId);
                }
                else if (path == "/audio/stop" && req.HttpMethod == "POST")
                {
                    _audioEngine.StopCapture();
                    responseJson = "{\"stopped\":true}";
                }
                else if (path == "/wake/status" && req.HttpMethod == "GET")
                {
                    responseJson = string.Format(
                        "{{\"isEnabled\":{0},\"isListening\":{1},\"wakePhrase\":\"Hey NEXUS\",\"sensitivity\":{2:0.00},\"vadThreshold\":{3:0.000},\"cooldownMs\":{4},\"isSelfTriggerSuppressed\":{5},\"lastTriggerAgeMs\":{6}}}",
                        _wakeEngine.IsEnabled.ToString().ToLowerInvariant(),
                        _wakeEngine.IsListening.ToString().ToLowerInvariant(),
                        _wakeEngine.Sensitivity,
                        _wakeEngine.VadThreshold,
                        _wakeEngine.CooldownMs,
                        _wakeEngine.IsSelfTriggerSuppressed.ToString().ToLowerInvariant(),
                        _wakeEngine.GetLastTriggerAgeMs()
                    );
                }
                else if (path == "/wake/simulate" && req.HttpMethod == "POST")
                {
                    string phrase = "Hey NEXUS";
                    float conf = 0.95f;
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd();
                        if (body.Contains("phrase"))
                        {
                            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""phrase""\s*:\s*""([^""]+)""");
                            if (m.Success) phrase = m.Groups[1].Value;
                        }
                        if (body.Contains("confidence"))
                        {
                            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""confidence""\s*:\s*([\d\.]+)");
                            if (m.Success) float.TryParse(m.Groups[1].Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out conf);
                        }
                    }

                    bool triggered = _wakeEngine.SimulateWake(phrase, conf);
                    responseJson = string.Format("{{\"triggered\":{0},\"phrase\":\"{1}\",\"confidence\":{2:0.00},\"orbState\":\"{3}\"}}",
                        triggered.ToString().ToLowerInvariant(), EscapeJson(phrase), conf, CurrentOrbState);
                }
                else if (path == "/hotkey/trigger" && req.HttpMethod == "POST")
                {
                    HandleHotkey();
                    responseJson = string.Format("{{\"triggered\":true,\"orbState\":\"{0}\"}}", CurrentOrbState);
                }
                else if (path == "/wake/config" && req.HttpMethod == "POST")
                {
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd();
                        if (body.Contains("sensitivity"))
                        {
                            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""sensitivity""\s*:\s*([\d\.]+)");
                            if (m.Success)
                            {
                                float sVal;
                                if (float.TryParse(m.Groups[1].Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out sVal))
                                    _wakeEngine.Sensitivity = sVal;
                            }
                        }
                        if (body.Contains("cooldownMs"))
                        {
                            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""cooldownMs""\s*:\s*(\d+)");
                            if (m.Success)
                            {
                                int cVal;
                                if (int.TryParse(m.Groups[1].Value, out cVal))
                                    _wakeEngine.CooldownMs = cVal;
                            }
                        }
                        if (body.Contains("enabled"))
                        {
                            if (body.Contains("\"enabled\":false") || body.Contains("\"enabled\": false"))
                                _wakeEngine.IsEnabled = false;
                            else if (body.Contains("\"enabled\":true") || body.Contains("\"enabled\": true"))
                                _wakeEngine.IsEnabled = true;
                        }
                    }
                    responseJson = string.Format("{{\"sensitivity\":{0:0.00},\"cooldownMs\":{1},\"isEnabled\":{2}}}",
                        _wakeEngine.Sensitivity, _wakeEngine.CooldownMs, _wakeEngine.IsEnabled.ToString().ToLowerInvariant());
                }
                else if (path == "/stt/status" && req.HttpMethod == "GET")
                {
                    responseJson = string.Format(
                        "{{\"isReady\":true,\"engine\":\"windows-offline-sapi-dictation\",\"sampleRate\":16000,\"isRecording\":{0},\"isBusy\":{1}}}",
                        _sttEngine.IsRecordingUtterance.ToString().ToLowerInvariant(),
                        _sttEngine.IsBusy.ToString().ToLowerInvariant()
                    );
                }
                else if (path == "/stt/transcribe" && req.HttpMethod == "POST")
                {
                    byte[] audioBytes = null;
                    int sampleRate = 16000;

                    if (req.ContentType != null && req.ContentType.Contains("application/json"))
                    {
                        using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                        {
                            string body = r.ReadToEnd();
                            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""pcmBase64""\s*:\s*""([^""]+)""");
                            if (m.Success)
                            {
                                audioBytes = Convert.FromBase64String(m.Groups[1].Value);
                            }
                            System.Text.RegularExpressions.Match sMatch = System.Text.RegularExpressions.Regex.Match(body, @"""sampleRate""\s*:\s*(\d+)");
                            if (sMatch.Success) int.TryParse(sMatch.Groups[1].Value, out sampleRate);
                        }
                    }
                    else
                    {
                        using (MemoryStream ms = new MemoryStream())
                        {
                            byte[] chunk = new byte[4096];
                            int read;
                            while ((read = req.InputStream.Read(chunk, 0, chunk.Length)) > 0)
                            {
                                ms.Write(chunk, 0, read);
                            }
                            audioBytes = ms.ToArray();
                        }
                    }

                    TranscriptionResult res = _sttEngine.TranscribePcm(audioBytes, sampleRate);
                    responseJson = string.Format(
                        "{{\"isSuccess\":{0},\"text\":\"{1}\",\"confidence\":{2:0.000},\"durationMs\":{3},\"errorMessage\":{4}}}",
                        res.IsSuccess.ToString().ToLowerInvariant(),
                        EscapeJson(res.Text),
                        res.Confidence,
                        res.DurationMs,
                        res.ErrorMessage != null ? string.Format("\"{0}\"", EscapeJson(res.ErrorMessage)) : "null"
                    );
                }
                else if (path == "/stt/cancel" && req.HttpMethod == "POST")
                {
                    _sttEngine.CancelUtterance();
                    responseJson = "{\"cancelled\":true}";
                }
                else if (path == "/tts/status" && req.HttpMethod == "GET")
                {
                    string currentV = (_ttsEngine != null) ? _ttsEngine.CurrentVoice : "None";
                    bool speaking = (_ttsEngine != null) && _ttsEngine.IsSpeaking;
                    int bCount = (_ttsEngine != null) ? _ttsEngine.BargeInCount : 0;
                    double lastLat = (_ttsEngine != null) ? _ttsEngine.LastBargeInLatencyMs : 0;
                    string actText = (_ttsEngine != null && _ttsEngine.ActiveText != null) ? string.Format("\"{0}\"", EscapeJson(_ttsEngine.ActiveText)) : "null";

                    StringBuilder voicesJson = new StringBuilder();
                    if (_ttsEngine != null)
                    {
                        var vList = _ttsEngine.InstalledVoices;
                        for (int i = 0; i < vList.Count; i++)
                        {
                            if (i > 0) voicesJson.Append(",");
                            voicesJson.AppendFormat("\"{0}\"", EscapeJson(vList[i]));
                        }
                    }

                    responseJson = string.Format(
                        "{{\"isSpeaking\":{0},\"currentVoice\":\"{1}\",\"installedVoices\":[{2}],\"bargeInCount\":{3},\"lastBargeInLatencyMs\":{4:0.00},\"activeText\":{5}}}",
                        speaking.ToString().ToLowerInvariant(),
                        EscapeJson(currentV),
                        voicesJson.ToString(),
                        bCount,
                        lastLat,
                        actText
                    );
                }
                else if (path == "/tts/speak" && req.HttpMethod == "POST")
                {
                    string text = "";
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd();
                        System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""text""\s*:\s*""([^""]+)""");
                        if (m.Success) text = m.Groups[1].Value;
                    }

                    bool started = false;
                    if (!string.IsNullOrEmpty(text) && _ttsEngine != null)
                    {
                        started = _ttsEngine.SpeakAsync(text);
                    }

                    responseJson = string.Format("{{\"started\":{0},\"text\":\"{1}\",\"isSpeaking\":{2}}}",
                        started.ToString().ToLowerInvariant(),
                        EscapeJson(text),
                        (_ttsEngine != null && _ttsEngine.IsSpeaking).ToString().ToLowerInvariant()
                    );
                }
                else if (path == "/tts/stop" && req.HttpMethod == "POST")
                {
                    bool stopped = false;
                    double lat = 0;
                    int count = 0;
                    if (_ttsEngine != null)
                    {
                        stopped = _ttsEngine.CancelSpeech("ipc-stop");
                        lat = _ttsEngine.LastBargeInLatencyMs;
                        count = _ttsEngine.BargeInCount;
                    }
                    ShowOrb("INTERRUPTED");
                    responseJson = string.Format("{{\"stopped\":{0},\"latencyMs\":{1:0.00},\"bargeInCount\":{2}}}",
                        stopped.ToString().ToLowerInvariant(),
                        lat,
                        count
                    );
                }
                else if (path == "/tts/synthesize" && req.HttpMethod == "POST")
                {
                    string text = "";
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd();
                        System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(body, @"""text""\s*:\s*""([^""]+)""");
                        if (m.Success) text = m.Groups[1].Value;
                    }

                    byte[] wav = (_ttsEngine != null) ? _ttsEngine.SynthesizeToWav(text) : new byte[0];
                    responseJson = string.Format("{{\"success\":{0},\"bytes\":{1},\"voice\":\"{2}\"}}",
                        (wav.Length > 0).ToString().ToLowerInvariant(),
                        wav.Length,
                        (_ttsEngine != null) ? EscapeJson(_ttsEngine.CurrentVoice) : "None"
                    );
                }
                else if (path == "/voice/status" && req.HttpMethod == "GET")
                {
                    responseJson = string.Format(
                        "{{\"state\":\"{0}\",\"orbVisible\":{1},\"sessionState\":\"{2}\",\"gatewayPort\":{3}}}",
                        CurrentOrbState, IsOrbVisible.ToString().ToLowerInvariant(), _sessionState, _gatewayPort
                    );
                }
                else if (path == "/voice/dispatch" && req.HttpMethod == "POST")
                {
                    string text = "";
                    string sessionId = "voice-session-default";
                    using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        string body = r.ReadToEnd();
                        System.Text.RegularExpressions.Match tm = System.Text.RegularExpressions.Regex.Match(body, @"""text""\s*:\s*""([^""]+)""");
                        if (tm.Success) text = tm.Groups[1].Value;

                        System.Text.RegularExpressions.Match sm = System.Text.RegularExpressions.Regex.Match(body, @"""sessionId""\s*:\s*""([^""]+)""");
                        if (sm.Success) sessionId = sm.Groups[1].Value;
                    }

                    responseJson = DispatchVoicePromptToGateway(text, sessionId);
                }
                else if (path == "/exit" && req.HttpMethod == "POST")
                {
                    responseJson = "{\"status\":\"exiting\"}";
                    byte[] b = Encoding.UTF8.GetBytes(responseJson);
                    resp.ContentLength64 = b.Length;
                    resp.OutputStream.Write(b, 0, b.Length);
                    resp.OutputStream.Close();

                    ThreadPool.QueueUserWorkItem(_ => ExitApplication());
                    return;
                }
                else
                {
                    resp.StatusCode = 404;
                    responseJson = "{\"error\":\"Not found\"}";
                }

                byte[] buffer = Encoding.UTF8.GetBytes(responseJson);
                resp.ContentLength64 = buffer.Length;
                resp.OutputStream.Write(buffer, 0, buffer.Length);
                resp.OutputStream.Close();
            }
            catch (Exception ex)
            {
                try
                {
                    resp.StatusCode = 500;
                    byte[] errBytes = Encoding.UTF8.GetBytes(string.Format("{{\"error\":\"{0}\"}}", ex.Message));
                    resp.ContentLength64 = errBytes.Length;
                    resp.OutputStream.Write(errBytes, 0, errBytes.Length);
                    resp.OutputStream.Close();
                }
                catch { }
            }
        }
        #endregion

        public string DispatchVoicePromptToGateway(string text, string sessionId = "voice-session-default")
        {
            if (string.IsNullOrEmpty(text))
            {
                return "{\"error\":\"EMPTY_PROMPT\",\"message\":\"Voice prompt cannot be empty.\"}";
            }

            ShowOrb("PROCESSING");

            try
            {
                string url = string.Format("http://127.0.0.1:{0}/api/chat", _gatewayPort);
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = 8000;

                string escapedText = EscapeJson(text);
                string payload = string.Format("{{\"sessionId\":\"{0}\",\"model\":\"nexus:latest\",\"messages\":[{{\"role\":\"user\",\"content\":\"{1}\"}}]}}",
                    sessionId, escapedText);

                byte[] bytes = Encoding.UTF8.GetBytes(payload);
                req.ContentLength = bytes.Length;

                using (Stream stream = req.GetRequestStream())
                {
                    stream.Write(bytes, 0, bytes.Length);
                }

                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string replyJson = reader.ReadToEnd();

                    if (replyJson.Contains("AUTHORIZATION_DENIED") || replyJson.Contains("SESSION_LOCKED") || replyJson.Contains("SESSION_UNVERIFIED"))
                    {
                        ShowOrb("AUTH_REQUIRED");
                    }
                    else if (replyJson.Contains("\"isError\":true") || replyJson.Contains("\"error\":"))
                    {
                        ShowOrb("ERROR");
                    }
                    else
                    {
                        ShowOrb("SPEAKING");
                        try
                        {
                            System.Text.RegularExpressions.Match cm = System.Text.RegularExpressions.Regex.Match(replyJson, @"""content""\s*:\s*""([^""]+)""");
                            if (cm.Success && _ttsEngine != null)
                            {
                                string spokenText = cm.Groups[1].Value.Replace("\\n", " ").Replace("\\\"", "\"");
                                if (!string.IsNullOrEmpty(spokenText))
                                {
                                    _ttsEngine.SpeakAsync(spokenText);
                                }
                            }
                        }
                        catch { }
                    }

                    return replyJson;
                }
            }
            catch (Exception ex)
            {
                ShowOrb("ERROR");
                return string.Format("{{\"error\":\"GATEWAY_DISPATCH_ERROR\",\"message\":\"{0}\"}}", EscapeJson(ex.Message));
            }
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "");
        }

        public void ExitApplication()
        {
            try
            {
                File.AppendAllText("C:\\MSC\\my-desk\\ai-personal-assistants\\apps\\desktop-companion\\crash.log", "\nExitApplication called from:\n" + Environment.StackTrace);
            }
            catch { }
            _isRunning = false;

            if (_sttEngine != null)
            {
                try { _sttEngine.Dispose(); } catch { }
            }

            if (_wakeEngine != null)
            {
                try { _wakeEngine.Dispose(); } catch { }
            }

            if (_audioEngine != null)
            {
                try { _audioEngine.Dispose(); } catch { }
            }

            if (_heartbeatTimer != null)
            {
                try { _heartbeatTimer.Dispose(); } catch { }
            }

            if (_httpListener != null)
            {
                try { _httpListener.Stop(); } catch { }
            }

            if (_orbWindow != null)
            {
                try { _orbWindow.Close(); } catch { }
            }

            if (_messageWindow != null)
            {
                _messageWindow.DestroyHandle();
            }

            if (_trayIcon != null)
            {
                _trayIcon.Visible = false;
                _trayIcon.Dispose();
            }

            ExitThread();
        }
    }

    #region Win32 Message Pump & Sentinel Window
    public class SessionMessageWindow : NativeWindow
    {
        private const int WM_DESTROY = 0x0002;
        private const int WM_POWERBROADCAST = 0x0218;
        private const int WM_WTSSESSION_CHANGE = 0x02B1;
        private const int WM_HOTKEY = 0x0312;

        private const int NOTIFY_FOR_THIS_SESSION = 0;
        private const int WTS_SESSION_LOCK = 0x7;
        private const int WTS_SESSION_UNLOCK = 0x8;

        private const int PBT_POWERSETTINGCHANGE = 0x8013;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;
        private const uint MOD_SHIFT = 0x0004;
        private const uint MOD_WIN = 0x0008;
        private const uint MOD_NOREPEAT = 0x4000;
        private const int HOTKEY_ID = 0x4E58; // 'NX'
        private const int HOTKEY_MUTE_ID = 0x4D54; // 'MT'

        private static Guid GUID_CONSOLE_DISPLAY_STATE = new Guid("6FE69556-9634-4636-A795-450F028FF0D2");

        private readonly CompanionContext _context;
        private IntPtr _powerNotifyHandle = IntPtr.Zero;
        private bool _isHotkeyRegistered = false;
        private bool _isMuteHotkeyRegistered = false;
        private string _activeHotkey = "None";

        public bool IsHotkeyRegistered { get { return _isHotkeyRegistered; } }
        public string ActiveHotkey { get { return _activeHotkey; } }

        public SessionMessageWindow(CompanionContext context)
        {
            _context = context;

            CreateParams cp = new CreateParams
            {
                Caption = "NEXUS_SessionSentinel_HiddenWindow",
                ClassName = "STATIC"
            };
            CreateHandle(cp);

            // Register WTS Session Notifications
            bool wtsOk = WTSRegisterSessionNotification(Handle, NOTIFY_FOR_THIS_SESSION);
            Console.WriteLine("[SENTINEL] WTSRegisterSessionNotification registered: " + wtsOk);

            // Register Power Display Notifications
            _powerNotifyHandle = RegisterPowerSettingNotification(Handle, ref GUID_CONSOLE_DISPLAY_STATE, 0);
            Console.WriteLine("[SENTINEL] RegisterPowerSettingNotification registered: " + (_powerNotifyHandle != IntPtr.Zero));

            // Register Global Hotkey (Attempt Win+Alt+N, fallback to Ctrl+Alt+N)
            _isHotkeyRegistered = RegisterHotKey(Handle, HOTKEY_ID, MOD_WIN | MOD_ALT | MOD_NOREPEAT, (uint)Keys.N);
            if (_isHotkeyRegistered)
            {
                _activeHotkey = "Win+Alt+N";
            }
            else
            {
                _isHotkeyRegistered = RegisterHotKey(Handle, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, (uint)Keys.N);
                if (_isHotkeyRegistered)
                {
                    _activeHotkey = "Ctrl+Alt+N";
                }
            }
            Console.WriteLine("[HOTKEY] RegisterHotKey (" + _activeHotkey + ") registered: " + _isHotkeyRegistered);
            _isMuteHotkeyRegistered = RegisterHotKey(Handle, HOTKEY_MUTE_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, (uint)Keys.M);
            Console.WriteLine("[HOTKEY] RegisterHotKey (Ctrl+Alt+M - Mute Toggle) registered: " + _isMuteHotkeyRegistered);
        }

        protected override void WndProc(ref Message m)
        {
            switch (m.Msg)
            {
                case WM_WTSSESSION_CHANGE:
                    int changeType = m.WParam.ToInt32();
                    if (changeType == WTS_SESSION_LOCK)
                    {
                        _context.HandleSessionLock();
                    }
                    else if (changeType == WTS_SESSION_UNLOCK)
                    {
                        _context.HandleSessionUnlock();
                    }
                    break;

                case WM_POWERBROADCAST:
                    if (m.WParam.ToInt32() == PBT_POWERSETTINGCHANGE)
                    {
                        POWERBROADCAST_SETTING setting = (POWERBROADCAST_SETTING)Marshal.PtrToStructure(m.LParam, typeof(POWERBROADCAST_SETTING));
                        if (setting.PowerSetting == GUID_CONSOLE_DISPLAY_STATE)
                        {
                            IntPtr pData = new IntPtr(m.LParam.ToInt64() + Marshal.SizeOf(typeof(POWERBROADCAST_SETTING)) - 1);
                            byte stateVal = Marshal.ReadByte(pData);
                            _context.HandleDisplayStateChange((int)stateVal);
                        }
                    }
                    break;

                case WM_HOTKEY:
                    int hotkeyId = m.WParam.ToInt32();
                    if (hotkeyId == HOTKEY_ID)
                    {
                        _context.HandleHotkey();
                    }
                    else if (hotkeyId == HOTKEY_MUTE_ID)
                    {
                        _context.ToggleMute();
                    }
                    break;

                case WM_DESTROY:
                    Cleanup();
                    break;
            }

            base.WndProc(ref m);
        }

        public void Cleanup()
        {
            if (_isHotkeyRegistered)
            {
                UnregisterHotKey(Handle, HOTKEY_ID);
                _isHotkeyRegistered = false;
            }
            if (_isMuteHotkeyRegistered)
            {
                UnregisterHotKey(Handle, HOTKEY_MUTE_ID);
                _isMuteHotkeyRegistered = false;
            }
            if (_powerNotifyHandle != IntPtr.Zero)
            {
                UnregisterPowerSettingNotification(_powerNotifyHandle);
                _powerNotifyHandle = IntPtr.Zero;
            }
            WTSUnRegisterSessionNotification(Handle);
        }

        #region P/Invoke Declarations
        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSRegisterSessionNotification(IntPtr hWnd, int dwFlags);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSUnRegisterSessionNotification(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr RegisterPowerSettingNotification(IntPtr hRecipient, ref Guid PowerSettingGuid, int Flags);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterPowerSettingNotification(IntPtr Handle);

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        private struct POWERBROADCAST_SETTING
        {
            public Guid PowerSetting;
            public int DataLength;
            public byte Data;
        }
        #endregion
    }
    #endregion

    #region Native Floating Animated Orb Form
    public class OrbForm : Form
    {
        private readonly CompanionContext _context;
        private readonly System.Windows.Forms.Timer _animTimer;
        private readonly System.Windows.Forms.Timer _autoHideTimer;
        private string _currentState = "IDLE";
        private float _pulseAngle = 0f;
        private float _orbitAngle = 0f;
        private volatile float _audioLevel = 0.0f;
        private int _autoHideTimeoutMs = 3000;
        private bool _isDragging = false;
        private Point _dragStart;
        private Point _currentPosition;

        public Point CurrentPosition
        {
            get { return _currentPosition; }
            set
            {
                _currentPosition = value;
                try
                {
                    if (InvokeRequired)
                    {
                        BeginInvoke(new Action(() => Location = value));
                    }
                    else
                    {
                        Location = value;
                    }
                }
                catch { }
            }
        }

        [DllImport("shell32.dll")]
        private static extern int SHQueryUserNotificationState(out int pquns);

        public static bool IsFullscreenOrPresentationMode()
        {
            try
            {
                int state;
                if (SHQueryUserNotificationState(out state) == 0)
                {
                    // 2 = QUNS_BUSY, 3 = QUNS_RUNNING_D3D_FULL_SCREEN, 4 = QUNS_PRESENTATION_MODE
                    return (state == 2 || state == 3 || state == 4);
                }
            }
            catch { }
            return false;
        }

        public string CurrentState { get { return _currentState; } }
        public float AudioLevel { get { return _audioLevel; } }
        public int AutoHideTimeoutMs { get { return _autoHideTimeoutMs; } set { _autoHideTimeoutMs = value; } }

        public void UpdateAudioLevel(float level)
        {
            _audioLevel = level;
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW (no taskbar / alt-tab)
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE (never steals focus!)
                cp.ExStyle |= 0x00000008; // WS_EX_TOPMOST
                return cp;
            }
        }

        public OrbForm(CompanionContext context)
        {
            _context = context;

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            Size = new Size(72, 72);
            BackColor = Color.Black;
            TransparencyKey = Color.Black;
            AllowTransparency = true;
            Opacity = 0.999f;

            // Anchor to bottom-right of primary screen working area
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            _currentPosition = new Point(wa.Right - 90, wa.Bottom - 90);
            Location = _currentPosition;

            // Circular clipping region
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddEllipse(0, 0, 72, 72);
                Region = new Region(path);
            }

            // Animation timer (30 FPS when active)
            _animTimer = new System.Windows.Forms.Timer { Interval = 33 };
            _animTimer.Tick += OnAnimationTick;

            // Auto-hide timer
            _autoHideTimer = new System.Windows.Forms.Timer { Interval = _autoHideTimeoutMs };
            _autoHideTimer.Tick += (s, e) =>
            {
                _autoHideTimer.Stop();
                if (_currentState == "IDLE")
                {
                    HideOrb();
                }
            };

            // Draggable window support
            MouseDown += (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    _isDragging = true;
                    _dragStart = e.Location;
                }
                else if (e.Button == MouseButtons.Right)
                {
                    _context.HideOrb();
                }
            };
            MouseMove += (s, e) =>
            {
                if (_isDragging)
                {
                    this.Left += e.X - _dragStart.X;
                    this.Top += e.Y - _dragStart.Y;
                    _currentPosition = this.Location;
                }
            };
            MouseUp += (s, e) =>
            {
                _isDragging = false;
            };
            DoubleClick += (s, e) => _context.HideOrb();
        }

        public void SetStateAndShow(string state)
        {
            _currentState = state;
            _autoHideTimer.Stop();

            if (state == "IDLE")
            {
                _autoHideTimer.Interval = _autoHideTimeoutMs;
                _autoHideTimer.Start();
            }

            if (!Visible)
            {
                Visible = true;
            }
            if (!_animTimer.Enabled)
            {
                _animTimer.Start();
            }
            Invalidate();
        }

        public void HideOrb()
        {
            _currentState = "IDLE";
            _animTimer.Stop();
            _autoHideTimer.Stop();
            Visible = false;
        }

        private void OnAnimationTick(object sender, EventArgs e)
        {
            _pulseAngle += 0.08f;
            _orbitAngle += 4.0f;
            if (_pulseAngle > Math.PI * 2) _pulseAngle = 0f;
            if (_orbitAngle >= 360f) _orbitAngle = 0f;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            float pulse = (float)(Math.Sin(_pulseAngle) * 0.5 + 0.5); // 0.0 to 1.0

            Color c1, c2, glowColor;
            switch (_currentState)
            {
                case "PROCESSING":
                    c1 = Color.FromArgb(99, 102, 241);   // Indigo
                    c2 = Color.FromArgb(168, 85, 247);   // Purple
                    glowColor = Color.FromArgb(120, 99, 102, 241);
                    break;
                case "SPEAKING":
                    c1 = Color.FromArgb(168, 85, 247);   // Purple
                    c2 = Color.FromArgb(236, 72, 153);   // Pink
                    glowColor = Color.FromArgb(140, 168, 85, 247);
                    break;
                case "INTERRUPTED":
                    c1 = Color.FromArgb(251, 146, 60);   // Amber-Orange
                    c2 = Color.FromArgb(239, 68, 68);    // Red
                    glowColor = Color.FromArgb(160, 251, 146, 60);
                    break;
                case "AUTH_REQUIRED":
                    c1 = Color.FromArgb(245, 158, 11);   // Amber
                    c2 = Color.FromArgb(217, 119, 6);    // Dark Amber
                    glowColor = Color.FromArgb(120, 245, 158, 11);
                    break;
                case "MUTED":
                    c1 = Color.FromArgb(107, 114, 128);  // Slate Gray
                    c2 = Color.FromArgb(75, 85, 99);     // Dark Gray
                    glowColor = Color.FromArgb(100, 239, 68, 68); // Muted red warning
                    break;
                case "LOCKED":
                    c1 = Color.FromArgb(30, 41, 59);    // Slate Navy
                    c2 = Color.FromArgb(15, 23, 42);    // Dark Slate
                    glowColor = Color.FromArgb(80, 59, 130, 246);
                    break;
                case "ERROR":
                    c1 = Color.FromArgb(239, 68, 68);    // Red
                    c2 = Color.FromArgb(185, 28, 28);
                    glowColor = Color.FromArgb(140, 239, 68, 68);
                    break;
                case "LISTENING":
                    c1 = Color.FromArgb(0, 210, 255);    // Cyan
                    c2 = Color.FromArgb(99, 102, 241);   // Indigo
                    glowColor = Color.FromArgb(140, 0, 210, 255);
                    break;
                case "IDLE":
                default:
                    c1 = Color.FromArgb(56, 189, 248);   // Sky Blue
                    c2 = Color.FromArgb(99, 102, 241);   // Indigo
                    glowColor = Color.FromArgb(60, 0, 210, 255);
                    break;
            }

            // Outer soft glow ring
            float audioBoost = (_currentState == "LISTENING" || _currentState == "SPEAKING") ? _audioLevel * 8f : 0f;
            int ringOffset = (int)(pulse * 3 + audioBoost);
            Rectangle outerRect = new Rectangle(4 - ringOffset, 4 - ringOffset, 64 + ringOffset * 2, 64 + ringOffset * 2);
            using (Pen glowPen = new Pen(glowColor, 2f))
            {
                g.DrawEllipse(glowPen, outerRect);
            }

            // Core gradient orb with orbital rotation
            Rectangle coreRect = new Rectangle(8, 8, 56, 56);
            using (LinearGradientBrush coreBrush = new LinearGradientBrush(coreRect, c1, c2, _orbitAngle))
            {
                g.FillEllipse(coreBrush, coreRect);
            }

            // Inner specular highlight
            Rectangle highlightRect = new Rectangle(16, 12, 24, 14);
            using (LinearGradientBrush hiBrush = new LinearGradientBrush(
                highlightRect,
                Color.FromArgb(180, 255, 255, 255),
                Color.FromArgb(0, 255, 255, 255),
                LinearGradientMode.Vertical))
            {
                g.FillEllipse(hiBrush, highlightRect);
            }
        }
    }
    #endregion
}
